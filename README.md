# Fix: `ApiError: Failed to connect workspace` (Sentry WEB-SZ)

Reproduction and fix for the production unhandled-promise-rejection reported in
[Sentry WEB-SZ](https://aether-a2.sentry.io/issues/7576272772/):

```
ApiError: Failed to connect workspace
mechanism: auto.browser.global_handlers.onunhandledrejection
transaction: /agents/d1a40527-1207-4bab-881f-c3d4e5cab635
```

## Root cause

The minified production frames map onto the real monorepo source:

| Minified frame | Real code |
| --- | --- |
| `Oe` → `POST /workspaces/{workspaceID}/connect` | `packages/api-client/.../clients/connectWorkspace.ts` |
| `auth-store` `request` / `startSpan` / the `!a.ok` throw | `packages/api-client/src/transport.ts` |
| `te` (`"...was superseded"`) and `new Jt(..., { maxRetries })` | the frontend **workspace connection manager** |

`POST /workspaces/{id}/connect` is designed to return a discriminated union —
`running` (with the WebSocket transport) or `connecting` (with `retry_after_ms`,
the "still warming up" path). When the server instead **persistently returns
`500`**, the transport raises an `ApiError` whose message is the server's body,
`"Failed to connect workspace"`. The breadcrumbs confirm both forms:

```
[error] sentry.event: ApiError: HTTP POST /workspaces/{workspaceID}/connect failed: 500
[error] console:      [WS] connect failed: ApiError: Failed to connect workspace
```

The connection manager wrapped the connect call in a retrier (`maxRetries`), but
**the final rejection was never caught at the call site**. Once retries were
exhausted the rejected promise escaped to the browser's global
`onunhandledrejection` handler (hence the `mechanism` tag) and was captured by
Sentry — 8 times in ~2 minutes, matching a retrying-then-giving-up loop — while
the user simply saw a silently broken workspace.

The API client transport itself is correct: surfacing a `500` as an `ApiError`
is intended. The defect is purely in **how the frontend handled that
rejection**.

## The fix

`src/workspace-connection.ts` — `WorkspaceConnectionManager` owns failure
handling so a connection error can never become an unhandled rejection:

1. **`connect()` never rejects** for operational failures. It always resolves
   with a discriminated `ConnectOutcome` (`connected` / `error` / `superseded` /
   `cancelled`). A forgotten `.catch` is now harmless.
2. On terminal failure it moves to an **`error` state**, emits an `error` event
   the UI can render, and **reports to telemetry exactly once** — a deliberate
   report that replaces the accidental unhandled-rejection capture.
3. **Retry classification**: transient conditions (`5xx`, `429`, `408`, network,
   timeout) are retried with backoff; terminal client errors (`401`, `402`,
   `403`, `404`, `409`, `422`) fail fast.
4. **Supersession** (a newer `connect()` / `disconnect()`) and **caller
   cancellation** (an `AbortSignal`) are benign — no error state, no report.
5. The **`connecting`** state is polled honoring `retry_after_ms`, bounded by
   `maxConnectingPolls` so a workspace that never becomes ready fails gracefully
   (a `504`) instead of polling forever.

## Run it

```bash
bun install
bun run repro      # reproduce the original unhandled rejection, then prove the fix
bun test           # 21 regression tests
bun run typecheck  # strict tsc --noEmit
```

`bun run repro` output:

```
=== 1) OLD buggy flow (fire-and-forget, no .catch) ===
unhandledRejections so far: 1
  -> ApiError: Failed to connect workspace
  REPRODUCED: this is the production onunhandledrejection (Sentry WEB-SZ).

=== 2) FIXED manager (same persistent 500) ===
new unhandledRejections: 0
connection state: error
last error: Failed to connect workspace (status 500)
telemetry reports: 1
PASS: fixed manager surfaces the failure with no unhandled rejection.
```

## Layout

| File | Purpose |
| --- | --- |
| `src/errors.ts` | `ApiError` + subclasses (mirror of `@aether/api-client`) |
| `src/connect-workspace.ts` | the `/connect` contract + injectable client |
| `src/retrier.ts` | bounded retrier (the `Jt` primitive) |
| `src/workspace-connection.ts` | **the fix** — `WorkspaceConnectionManager` |
| `repro/unhandled-rejection.ts` | before/after reproduction |
| `src/__tests__/workspace-connection.test.ts` | regression suite |

> Note: this sandbox repo did not contain the `app.runaether.dev` frontend
> source (it lives outside this checkout). The connection manager here is
> reconstructed faithfully from the production stack trace and the real
> `@aether/api-client` contracts so the bug can be reproduced and the fix
> verified end-to-end.
