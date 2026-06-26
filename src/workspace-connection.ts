/**
 * Workspace connection manager — the un-minified, *fixed* shape of the
 * frontend code in the production stack trace (`Workspace-rSCrLVFB.js`:
 * `te` / `Oe` / `new Jt(..., { maxRetries })`).
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE BUG (Sentry WEB-SZ — "Failed to connect workspace")
 * ────────────────────────────────────────────────────────────────────────
 * `POST /workspaces/{id}/connect` is designed to return either `running`
 * (with transport) or `connecting` (with `retry_after_ms`). When the server
 * instead persistently returns 500, the transport throws an `ApiError`
 * ("Failed to connect workspace"). The old call site `await`ed the retrier
 * but did NOT catch the final rejection, so once `maxRetries` was exhausted
 * the rejected promise escaped to the browser's global
 * `onunhandledrejection` handler (see the event's
 * `mechanism: auto.browser.global_handlers.onunhandledrejection`) and was
 * captured by Sentry. The user just saw a silently broken workspace.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE FIX
 * ────────────────────────────────────────────────────────────────────────
 * The manager now *owns* failure handling:
 *   1. `connect()` NEVER rejects for operational failures — it always resolves
 *      with a discriminated `ConnectOutcome`. A forgotten `.catch` can no
 *      longer become an unhandled rejection.
 *   2. On terminal failure it transitions to an `error` state, emits an
 *      `error` event the UI can render, and reports the error to telemetry
 *      exactly once (a deliberate report that replaces the accidental
 *      unhandled-rejection capture).
 *   3. Retries are classified: transient conditions (5xx / 429 / 408 /
 *      network / timeout) are retried with backoff; terminal client errors
 *      (401 / 402 / 403 / 404 / 409 / 422) fail fast.
 *   4. Supersession (a newer connect, or `disconnect()`) and caller
 *      cancellation are treated as benign — no error state, no report.
 *   5. The `connecting` state is polled honoring `retry_after_ms`, bounded so
 *      a workspace that never becomes ready fails gracefully instead of
 *      polling forever.
 */

import {
  ApiError,
  CancelledError,
  NetworkError,
  TimeoutError,
  isApiError,
  isCancelledError,
} from "./errors";
import {
  connectWorkspace,
  type ConnectWorkspaceClient,
  type WorkspaceConnectTransport,
} from "./connect-workspace";
import { Retrier, type SleepFn, defaultSleep } from "./retrier";

export type ConnectionState = "idle" | "connecting" | "connected" | "error";

export interface WorkspaceSocket {
  readonly url: string;
  close(): void;
}

export type ConnectOutcome =
  | { status: "connected"; socket: WorkspaceSocket }
  | { status: "superseded" }
  | { status: "cancelled" }
  | { status: "error"; error: ApiError };

export interface ConnectionTelemetry {
  reportError(
    error: ApiError,
    context: { workspaceID: string; operation: string; area: string }
  ): void;
}

export interface ConnectionLogger {
  error(...args: unknown[]): void;
}

export interface ReconnectPolicy {
  /** Bounded auto-reconnect after a terminal error. 0 disables it (default). */
  readonly maxAttempts: number;
  /** Delay before each reconnect attempt. */
  readonly delayMs: number;
}

export interface WorkspaceConnectionOptions {
  readonly client: ConnectWorkspaceClient;
  /** Base origin for the WebSocket URL, e.g. "wss://app.runaether.dev". */
  readonly socketBaseUrl: string;
  /** Opens the live socket once a `running` transport is obtained. */
  readonly openSocket?: (url: string) => WorkspaceSocket;
  readonly telemetry?: ConnectionTelemetry;
  readonly logger?: ConnectionLogger;
  readonly sleep?: SleepFn;
  /** Additional attempts after the first on a transient error. Default 3. */
  readonly maxRetries?: number;
  /** Max `connecting` polls before giving up gracefully. Default 30. */
  readonly maxConnectingPolls?: number;
  /** Clamp server-provided `retry_after_ms` into a sane window. */
  readonly retryAfterBoundsMs?: { min: number; max: number };
  readonly reconnect?: ReconnectPolicy;
}

type EventMap = {
  statechange: { state: ConnectionState; previous: ConnectionState };
  connected: { workspaceID: string; socket: WorkspaceSocket };
  error: { workspaceID: string; error: ApiError };
};

/** Internal sentinel: a newer connect (or disconnect) superseded this attempt. */
class SupersededError extends Error {
  constructor(workspaceID: string) {
    super(`Workspace connection for ${workspaceID} was superseded`);
    this.name = "SupersededError";
  }
}

/** The workspace never reached `running` within the poll budget. Terminal. */
class WorkspaceNotReadyError extends ApiError {
  constructor(init: { workspaceID: string; lastDisplayState: string }) {
    super({
      message: `Workspace ${init.workspaceID} did not become ready (last state: ${init.lastDisplayState})`,
      status: 504,
      code: "workspace_connect_timeout",
      method: "POST",
      path: `/workspaces/${init.workspaceID}/connect`,
      operation: "workspaces.connect",
      area: "workspaces",
    });
    this.name = "WorkspaceNotReadyError";
  }
}

const DEFAULT_OPEN_SOCKET = (url: string): WorkspaceSocket => ({ url, close() {} });

export class WorkspaceConnectionManager {
  private generation = 0;
  private state: ConnectionState = "idle";
  private lastError: ApiError | undefined;
  private activeSocket: WorkspaceSocket | null = null;
  private activeController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectsUsed = 0;
  private readonly listeners: { [K in keyof EventMap]: Set<(payload: EventMap[K]) => void> } = {
    statechange: new Set(),
    connected: new Set(),
    error: new Set(),
  };

  private readonly client: ConnectWorkspaceClient;
  private readonly socketBaseUrl: string;
  private readonly openSocket: (url: string) => WorkspaceSocket;
  private readonly telemetry: ConnectionTelemetry;
  private readonly logger: ConnectionLogger;
  private readonly sleep: SleepFn;
  private readonly maxRetries: number;
  private readonly maxConnectingPolls: number;
  private readonly retryAfterBounds: { min: number; max: number };
  private readonly reconnectPolicy: ReconnectPolicy;

  constructor(options: WorkspaceConnectionOptions) {
    this.client = options.client;
    this.socketBaseUrl = options.socketBaseUrl;
    this.openSocket = options.openSocket ?? DEFAULT_OPEN_SOCKET;
    this.telemetry = options.telemetry ?? { reportError() {} };
    this.logger = options.logger ?? console;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxConnectingPolls = options.maxConnectingPolls ?? 30;
    this.retryAfterBounds = options.retryAfterBoundsMs ?? { min: 250, max: 10_000 };
    this.reconnectPolicy = options.reconnect ?? { maxAttempts: 0, delayMs: 2_000 };
  }

  getState(): ConnectionState {
    return this.state;
  }

  getLastError(): ApiError | undefined {
    return this.lastError;
  }

  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): () => void {
    this.listeners[event].add(handler);
    return () => this.listeners[event].delete(handler);
  }

  /**
   * Connect (or reconnect) to a workspace.
   *
   * Resolves with a `ConnectOutcome` describing what happened and NEVER
   * rejects for an operational failure — that guarantee is what closes the
   * unhandled-rejection hole. Callers may inspect the outcome, but ignoring
   * the returned promise is now safe.
   */
  async connect(
    workspaceID: string,
    opts: { signal?: AbortSignal | undefined } = {}
  ): Promise<ConnectOutcome> {
    const myGen = this.beginAttempt();
    const controller = new AbortController();
    this.activeController = controller;
    this.lastError = undefined;
    this.setState("connecting");

    // Caller-supplied cancellation (e.g. React effect cleanup on unmount).
    const callerSignal = opts.signal;
    if (callerSignal?.aborted) {
      this.setState("idle");
      return { status: "cancelled" };
    }
    const onCallerAbort = () => controller.abort(this.cancelledError("caller_cancelled"));
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const transport = await this.resolveTransport(workspaceID, myGen, controller.signal);
      if (this.isSuperseded(myGen)) {
        return { status: "superseded" };
      }
      const socket = this.openSocketFromTransport(workspaceID, transport);
      this.activeSocket = socket;
      this.reconnectsUsed = 0;
      this.setState("connected");
      this.emit("connected", { workspaceID, socket });
      return { status: "connected", socket };
    } catch (err) {
      return this.handleConnectError(workspaceID, myGen, err);
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** Tear down the active connection and supersede any in-flight attempt. */
  disconnect(): void {
    this.generation += 1; // supersede in-flight connect()
    this.clearReconnect();
    this.activeController?.abort(this.cancelledError("client_disconnect"));
    this.activeController = null;
    this.activeSocket?.close();
    this.activeSocket = null;
    this.setState("idle");
  }

  // ── internals ──────────────────────────────────────────────────────────

  private beginAttempt(): number {
    this.clearReconnect();
    // Abort a previous in-flight attempt so its fetch unwinds as a cancel,
    // not as a competing error.
    this.activeController?.abort(this.cancelledError("superseded_by_newer_connect"));
    this.generation += 1;
    return this.generation;
  }

  private cancelledError(
    code: "superseded_by_newer_connect" | "client_disconnect" | "caller_cancelled"
  ): CancelledError {
    return new CancelledError({
      message: "workspace connection cancelled",
      code,
      method: "POST",
      path: "/workspaces/connect",
      operation: "workspaces.connect",
      area: "workspaces",
    });
  }

  private async resolveTransport(
    workspaceID: string,
    myGen: number,
    signal: AbortSignal
  ): Promise<WorkspaceConnectTransport> {
    const retrier = new Retrier<WorkspaceConnectTransport>(
      () => this.pollUntilRunning(workspaceID, myGen, signal),
      {
        maxRetries: this.maxRetries,
        isRetryable: (error) => this.isRetryableError(error),
        sleep: this.sleep,
        signal,
      }
    );
    return await retrier.run();
  }

  /**
   * Poll `connect` until the workspace reports `running`, honoring the
   * server's `retry_after_ms` for the `connecting` state. Bounded by
   * `maxConnectingPolls` so a stuck workspace fails gracefully.
   *
   * A thrown `ApiError` (e.g. a transient 500) propagates to the surrounding
   * `Retrier`, which decides whether to retry the whole poll.
   */
  private async pollUntilRunning(
    workspaceID: string,
    myGen: number,
    signal: AbortSignal
  ): Promise<WorkspaceConnectTransport> {
    let polls = 0;
    let lastDisplayState = "unknown";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.assertActive(myGen);
      const resp = await connectWorkspace({ workspaceID }, { client: this.client, signal });
      // A response can arrive after a newer connect() started — drop it.
      this.assertActive(myGen);

      if (resp.state === "running") {
        return resp.transport;
      }

      lastDisplayState = resp.display_state;
      polls += 1;
      if (polls >= this.maxConnectingPolls) {
        throw new WorkspaceNotReadyError({ workspaceID, lastDisplayState });
      }
      await this.sleep(this.clampRetryAfter(resp.retry_after_ms), signal);
    }
  }

  private handleConnectError(workspaceID: string, myGen: number, err: unknown): ConnectOutcome {
    // Benign: cancellation. A newer connect() supersedes; an explicit
    // disconnect()/caller-signal cancels. Distinguished by the abort code so a
    // superseded attempt never resets the newer attempt's state. Never reported.
    if (isCancelledError(err)) {
      if (err.code === "superseded_by_newer_connect") {
        return { status: "superseded" };
      }
      if (this.state === "connecting") this.setState("idle");
      return { status: "cancelled" };
    }
    // Benign: superseded mid-flight (generation moved on, e.g. via assertActive).
    if (err instanceof SupersededError || this.isSuperseded(myGen)) {
      return { status: "superseded" };
    }

    const apiError = this.asApiError(err, workspaceID);
    this.lastError = apiError;
    this.setState("error");

    // Single deliberate telemetry report. In production the per-attempt
    // transport reports are suppressed (suppressErrorReport) so this is the
    // one canonical record — and it replaces the accidental
    // onunhandledrejection capture that created Sentry WEB-SZ.
    this.telemetry.reportError(apiError, {
      workspaceID,
      operation: "workspaces.connect",
      area: "workspaces",
    });
    this.emit("error", { workspaceID, error: apiError });
    this.logger.error("[WS] connect failed:", apiError);

    this.maybeScheduleReconnect(workspaceID);
    return { status: "error", error: apiError };
  }

  private openSocketFromTransport(
    workspaceID: string,
    transport: WorkspaceConnectTransport
  ): WorkspaceSocket {
    // Mirrors `new URL(e.webSocketUrl); n.searchParams.set("token", ...)`.
    const url = new URL(transport.websocket_path, this.socketBaseUrl);
    url.searchParams.set("token", transport.preview_token);
    url.searchParams.set("workspace_id", workspaceID);
    return this.openSocket(url.toString());
  }

  private maybeScheduleReconnect(workspaceID: string): void {
    if (this.reconnectsUsed >= this.reconnectPolicy.maxAttempts) {
      return;
    }
    this.reconnectsUsed += 1;
    const gen = this.generation;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Only reconnect if nothing else changed the connection in the meantime.
      if (this.generation === gen && this.state === "error") {
        void this.connect(workspaceID);
      }
    }, this.reconnectPolicy.delayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private assertActive(myGen: number): void {
    if (this.isSuperseded(myGen)) {
      throw new SupersededError(String(myGen));
    }
  }

  private isSuperseded(myGen: number): boolean {
    return this.generation !== myGen;
  }

  private clampRetryAfter(ms: number): number {
    const value = Number.isFinite(ms) ? ms : this.retryAfterBounds.min;
    return Math.min(this.retryAfterBounds.max, Math.max(this.retryAfterBounds.min, value));
  }

  /**
   * Retry policy. Transient conditions are retried; terminal client errors
   * fail fast; benign sentinels are never retried (handled by `connect()`).
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof SupersededError) return false;
    if (isCancelledError(error)) return false;
    if (error instanceof WorkspaceNotReadyError) return false; // poll budget already spent
    if (error instanceof NetworkError) return true; // status 0
    if (error instanceof TimeoutError) return true; // status -1
    if (isApiError(error)) {
      if (error.status >= 500) return true;
      if (error.status === 429 || error.status === 408) return true;
      return false; // 4xx terminal: 401/402/403/404/409/422
    }
    return false; // unknown, non-ApiError: don't blindly retry
  }

  private asApiError(err: unknown, workspaceID: string): ApiError {
    if (isApiError(err)) return err;
    return new ApiError({
      message: err instanceof Error ? err.message : "Failed to connect workspace",
      status: 0,
      code: "workspace_connect_failed",
      method: "POST",
      path: `/workspaces/${workspaceID}/connect`,
      operation: "workspaces.connect",
      area: "workspaces",
      cause: err,
    });
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.emit("statechange", { state: next, previous });
  }

  private emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const handler of this.listeners[event]) {
      try {
        handler(payload);
      } catch (handlerError) {
        // A listener throwing must never break the connection state machine
        // or — worse — resurface as an unhandled rejection.
        this.logger.error("[WS] connection listener threw:", handlerError);
      }
    }
  }
}
