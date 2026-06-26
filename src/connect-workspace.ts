/**
 * Faithful model of the `POST /workspaces/{workspaceID}/connect` contract and
 * client, derived from the real generated client in
 * `packages/api-client/src/generated/aether-api/clients/connectWorkspace.ts`.
 *
 * The endpoint returns a discriminated union:
 *   - `running`    — the workspace is up; `transport` carries the WebSocket
 *                    path + preview token used to open the live connection.
 *   - `connecting` — the workspace is still starting; the caller should wait
 *                    `retry_after_ms` and call connect again (this is the
 *                    *designed* "still warming up" path, returned as 200).
 *
 * A 500 (or other error status) is NOT part of this union — the transport
 * raises an `ApiError` for it. The production incident is exactly that: a
 * persistent 500 instead of a graceful `connecting` response.
 */

import type { ApiError } from "./errors";

export type WorkspaceDisplayState =
  | "deleted"
  | "idle"
  | "starting"
  | "stopping"
  | "suspending"
  | "destroying"
  | "ready"
  | "preparing"
  | "error"
  | "stopped"
  | "suspended";

export interface WorkspaceConnectTransport {
  /** 32-char lowercase alphanumeric preview token. */
  readonly preview_token: string;
  /** Server-relative WebSocket path, e.g. `/workspace`. */
  readonly websocket_path: string;
}

export interface ConnectWorkspaceRunning {
  readonly state: "running";
  readonly workspace_id: string;
  readonly display_state: WorkspaceDisplayState;
  readonly transport: WorkspaceConnectTransport;
  readonly last_started_at?: string;
}

export interface ConnectWorkspaceConnecting {
  readonly state: "connecting";
  readonly workspace_id: string;
  readonly display_state: WorkspaceDisplayState;
  /** How long the client should wait before polling connect again. */
  readonly retry_after_ms: number;
  readonly last_started_at?: string;
}

export type ConnectWorkspaceResponse = ConnectWorkspaceRunning | ConnectWorkspaceConnecting;

/**
 * The injectable transport. In production this is the generated kubb client
 * backed by `@aether/api-client`'s transport (which throws `ApiError` on
 * non-2xx). Tests pass a stub that resolves a `ConnectWorkspaceResponse` or
 * rejects with an `ApiError`.
 */
export interface ConnectWorkspaceClient {
  (args: { workspaceID: string; signal?: AbortSignal | undefined }):
    | Promise<ConnectWorkspaceResponse>
    | ConnectWorkspaceResponse;
}

/** Mirrors the generated `connectWorkspace(...)` call site shape. */
export async function connectWorkspace(
  { workspaceID }: { workspaceID: string },
  config: { client: ConnectWorkspaceClient; signal?: AbortSignal | undefined }
): Promise<ConnectWorkspaceResponse> {
  return await config.client({ workspaceID, signal: config.signal });
}

export type { ApiError };
