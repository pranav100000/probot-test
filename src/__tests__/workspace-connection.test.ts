import { afterEach, describe, expect, test } from "bun:test";

import { ApiError, NetworkError, TimeoutError } from "../errors";
import type {
  ConnectWorkspaceClient,
  ConnectWorkspaceResponse,
  WorkspaceConnectTransport,
} from "../connect-workspace";
import {
  WorkspaceConnectionManager,
  type ConnectionState,
  type ConnectOutcome,
  type WorkspaceConnectionOptions,
} from "../workspace-connection";

const WS = "d1a40527-1207-4bab-881f-c3d4e5cab635";
const immediateSleep = async (_ms: number) => {};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function runningResp(
  transport: Partial<WorkspaceConnectTransport> = {}
): ConnectWorkspaceResponse {
  return {
    state: "running",
    workspace_id: WS,
    display_state: "ready",
    transport: {
      preview_token: "a".repeat(32),
      websocket_path: "/workspace",
      ...transport,
    },
  };
}

function connectingResp(retry_after_ms = 500): ConnectWorkspaceResponse {
  return {
    state: "connecting",
    workspace_id: WS,
    display_state: "starting",
    retry_after_ms,
  };
}

function apiErr(status: number, message = `HTTP POST failed: ${status}`): ApiError {
  return new ApiError({
    message,
    status,
    method: "POST",
    path: `/workspaces/${WS}/connect`,
    operation: "workspaces.connect",
    area: "workspaces",
  });
}

/** A client that yields each scripted step (value -> resolve, Error -> reject). */
function scriptedClient(
  steps: Array<ConnectWorkspaceResponse | Error>
): ConnectWorkspaceClient & { calls: () => number } {
  if (steps.length === 0) throw new Error("scriptedClient needs at least one step");
  let i = 0;
  const client: ConnectWorkspaceClient = () => {
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return step instanceof Error
      ? Promise.reject(step)
      : Promise.resolve<ConnectWorkspaceResponse>(step);
  };
  return Object.assign(client, { calls: () => i });
}

/** A client that never resolves on its own; rejects with the abort reason. */
function signalAwareClient(): ConnectWorkspaceClient {
  return ({ signal }) =>
    new Promise<ConnectWorkspaceResponse>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeManager(overrides: Partial<WorkspaceConnectionOptions> & { client: ConnectWorkspaceClient }) {
  const reports: ApiError[] = [];
  const errorEvents: ApiError[] = [];
  const states: ConnectionState[] = [];
  const manager = new WorkspaceConnectionManager({
    socketBaseUrl: "wss://app.runaether.dev",
    sleep: immediateSleep,
    logger: { error: () => {} },
    telemetry: { reportError: (err) => reports.push(err) },
    ...overrides,
  });
  manager.on("error", ({ error }) => errorEvents.push(error));
  manager.on("statechange", ({ state }) => states.push(state));
  return { manager, reports, errorEvents, states };
}

// Captures unhandled rejections for the duration of a single test.
function captureUnhandled() {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", handler);
  return {
    count: () => seen.length,
    messages: () => seen.map((r) => (r instanceof Error ? `${r.name}: ${r.message}` : String(r))),
    restore: () => process.off("unhandledRejection", handler),
  };
}

describe("WorkspaceConnectionManager — production regression (Sentry WEB-SZ)", () => {
  test("persistent 500 does NOT leak an unhandled rejection (the bug)", async () => {
    const capture = captureUnhandled();
    try {
      const { manager, reports, errorEvents } = makeManager({
        client: scriptedClient([apiErr(500, "Failed to connect workspace")]),
        maxRetries: 3,
      });

      // The exact production call shape: fire-and-forget, no `.catch`.
      void manager.connect(WS);
      await tick(20);

      expect(capture.count()).toBe(0); // <- was 1 ("ApiError: Failed to connect workspace")
      expect(manager.getState()).toBe("error");
      expect(manager.getLastError()?.message).toBe("Failed to connect workspace");
      expect(manager.getLastError()?.status).toBe(500);
      expect(errorEvents).toHaveLength(1); // surfaced to the UI
      expect(reports).toHaveLength(1); // reported once, deliberately
    } finally {
      capture.restore();
    }
  });

  test("awaited connect() resolves (never rejects) on terminal failure", async () => {
    const { manager } = makeManager({ client: scriptedClient([apiErr(500)]), maxRetries: 1 });
    const outcome = await manager.connect(WS); // would throw if connect() rejected
    expect(outcome.status).toBe("error");
  });

  // The mirror-image proof — that the OLD flow *did* leak an unhandled
  // rejection — lives in `repro/unhandled-rejection.ts`, run outside the test
  // runner (bun's harness treats a deliberate unhandled rejection as a
  // failure). Here, both this suite's `captureUnhandled()` assertions and
  // bun's own unhandled-rejection detection act as the regression backstop.
});

describe("WorkspaceConnectionManager — happy paths", () => {
  test("running response connects and builds the socket URL with token", async () => {
    const opened: string[] = [];
    const { manager, reports } = makeManager({
      client: scriptedClient([runningResp()]),
      openSocket: (url) => {
        opened.push(url);
        return { url, close() {} };
      },
    });

    const outcome = await manager.connect(WS);
    expect(outcome.status).toBe("connected");
    expect(manager.getState()).toBe("connected");
    expect(reports).toHaveLength(0);
    const url = new URL(opened[0]!);
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/workspace");
    expect(url.searchParams.get("token")).toBe("a".repeat(32));
    expect(url.searchParams.get("workspace_id")).toBe(WS);
  });

  test("polls the 'connecting' state honoring retry_after_ms, then connects", async () => {
    const sleeps: number[] = [];
    const { manager } = makeManager({
      client: scriptedClient([connectingResp(500), connectingResp(800), runningResp()]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const outcome = await manager.connect(WS);
    expect(outcome.status).toBe("connected");
    expect(sleeps).toEqual([500, 800]); // waited exactly as the server asked
  });

  test("clamps an out-of-range retry_after_ms", async () => {
    const sleeps: number[] = [];
    const { manager } = makeManager({
      client: scriptedClient([connectingResp(5), connectingResp(999_999), runningResp()]),
      retryAfterBoundsMs: { min: 250, max: 10_000 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await manager.connect(WS);
    expect(sleeps).toEqual([250, 10_000]);
  });
});

describe("WorkspaceConnectionManager — retry classification", () => {
  test("retries a transient 500 then succeeds", async () => {
    const client = scriptedClient([apiErr(500), apiErr(500), runningResp()]);
    const { manager, reports } = makeManager({ client, maxRetries: 3 });
    const outcome = await manager.connect(WS);
    expect(outcome.status).toBe("connected");
    expect(client.calls()).toBe(3);
    expect(reports).toHaveLength(0);
  });

  test("retries network and timeout errors", async () => {
    for (const transient of [
      new NetworkError({ message: "net", method: "POST", path: "/x", operation: "o", area: "a" }),
      new TimeoutError({ message: "to", method: "POST", path: "/x", operation: "o", area: "a" }),
      apiErr(429),
      apiErr(408),
      apiErr(503),
    ]) {
      const client = scriptedClient([transient, runningResp()]);
      const { manager } = makeManager({ client, maxRetries: 2 });
      const outcome = await manager.connect(WS);
      expect(outcome.status).toBe("connected");
      expect(client.calls()).toBe(2);
    }
  });

  test.each([401, 402, 403, 404, 409, 422])(
    "fails fast (no retry) on terminal %i",
    async (status) => {
      const client = scriptedClient([apiErr(status)]);
      const { manager, reports } = makeManager({ client, maxRetries: 5 });
      const outcome = await manager.connect(WS);
      expect(outcome.status).toBe("error");
      expect((outcome as Extract<ConnectOutcome, { status: "error" }>).error.status).toBe(status);
      expect(client.calls()).toBe(1); // not retried
      expect(reports).toHaveLength(1);
    }
  );

  test("exhausts retries on a persistent 500 then errors gracefully", async () => {
    const client = scriptedClient([apiErr(500)]); // always 500
    const { manager } = makeManager({ client, maxRetries: 2 });
    const outcome = await manager.connect(WS);
    expect(outcome.status).toBe("error");
    expect(client.calls()).toBe(3); // 1 + 2 retries
  });

  test("a workspace stuck 'connecting' fails gracefully (504), not forever", async () => {
    const client = scriptedClient([connectingResp(250)]); // never becomes running
    const { manager } = makeManager({ client, maxConnectingPolls: 4, maxRetries: 0 });
    const outcome = await manager.connect(WS);
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<ConnectOutcome, { status: "error" }>).error.status).toBe(504);
    expect(client.calls()).toBe(4);
  });
});

describe("WorkspaceConnectionManager — supersession & cancellation (benign)", () => {
  test("a newer connect() supersedes the in-flight one without an error report", async () => {
    let call = 0;
    const d = deferred<ConnectWorkspaceResponse>();
    const client: ConnectWorkspaceClient = () => {
      call += 1;
      return call === 1 ? d.promise : Promise.resolve(runningResp());
    };
    const { manager, reports, errorEvents } = makeManager({ client });

    const p1 = manager.connect(WS); // call #1 -> pending
    await tick();
    const p2 = manager.connect(WS); // supersedes; call #2 -> running
    const r2 = await p2;
    d.resolve(runningResp()); // late resolution of the superseded attempt
    const r1 = await p1;

    expect(r2.status).toBe("connected");
    expect(r1.status).toBe("superseded");
    expect(manager.getState()).toBe("connected"); // newer attempt owns state
    expect(reports).toHaveLength(0);
    expect(errorEvents).toHaveLength(0);
  });

  test("disconnect() cancels the in-flight connect, no error report", async () => {
    const { manager, reports } = makeManager({ client: signalAwareClient() });
    const p = manager.connect(WS);
    await tick();
    manager.disconnect();
    const outcome = await p;
    expect(outcome.status).toBe("cancelled");
    expect(manager.getState()).toBe("idle");
    expect(reports).toHaveLength(0);
  });

  test("a caller AbortSignal cancels the connect", async () => {
    const ac = new AbortController();
    const { manager, reports } = makeManager({ client: signalAwareClient() });
    const p = manager.connect(WS, { signal: ac.signal });
    await tick();
    ac.abort();
    const outcome = await p;
    expect(outcome.status).toBe("cancelled");
    expect(manager.getState()).toBe("idle");
    expect(reports).toHaveLength(0);
  });

  test("an already-aborted caller signal returns cancelled immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const { manager } = makeManager({ client: scriptedClient([runningResp()]) });
    const outcome = await manager.connect(WS, { signal: ac.signal });
    expect(outcome.status).toBe("cancelled");
  });
});

describe("WorkspaceConnectionManager — resilience extras", () => {
  test("bounded auto-reconnect recovers after a transient failure", async () => {
    let call = 0;
    const client: ConnectWorkspaceClient = () => {
      call += 1;
      return call === 1 ? Promise.reject(apiErr(500)) : Promise.resolve(runningResp());
    };
    const { manager } = makeManager({
      client,
      maxRetries: 0,
      reconnect: { maxAttempts: 1, delayMs: 1 },
    });

    const outcome = await manager.connect(WS);
    expect(outcome.status).toBe("error"); // first attempt fails
    await tick(25); // let the bounded reconnect fire
    expect(manager.getState()).toBe("connected");
  });

  test("a throwing event listener never breaks the state machine or leaks", async () => {
    const capture = captureUnhandled();
    try {
      const { manager } = makeManager({ client: scriptedClient([runningResp()]) });
      manager.on("statechange", () => {
        throw new Error("listener boom");
      });
      const outcome = await manager.connect(WS);
      await tick(10);
      expect(outcome.status).toBe("connected");
      expect(capture.count()).toBe(0);
    } finally {
      capture.restore();
    }
  });
});
