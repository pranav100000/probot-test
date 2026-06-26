/**
 * Reproduction for Sentry WEB-SZ — "Failed to connect workspace".
 *
 * Run: `bun run repro/unhandled-rejection.ts`
 *
 * It drives two implementations against a workspace whose `/connect` endpoint
 * persistently returns 500:
 *
 *   1. `buggyConnect` — the OLD shape: a retrier whose final rejection is not
 *      caught at the call site. This is what produced the production
 *      `onunhandledrejection` Sentry capture.
 *
 *   2. `WorkspaceConnectionManager` — the FIXED shape: failures are owned by
 *      the manager (error state + single telemetry report), so a forgotten
 *      `.catch` can no longer leak an unhandled rejection.
 */

import { ApiError } from "../src/errors";
import type { ConnectWorkspaceClient, ConnectWorkspaceResponse } from "../src/connect-workspace";
import { Retrier } from "../src/retrier";
import { WorkspaceConnectionManager } from "../src/workspace-connection";

const WORKSPACE_ID = "d1a40527-1207-4bab-881f-c3d4e5cab635";
const immediateSleep = async () => {};

/** A client that always fails the way production did: 500 + that message. */
const always500: ConnectWorkspaceClient = (): Promise<ConnectWorkspaceResponse> => {
  return Promise.reject(
    new ApiError({
      message: "Failed to connect workspace",
      status: 500,
      method: "POST",
      path: `/workspaces/${WORKSPACE_ID}/connect`,
      operation: "workspaces.connect",
      area: "workspaces",
    })
  );
};

// ── OLD (buggy) connection flow ───────────────────────────────────────────
async function buggyConnect(workspaceID: string): Promise<void> {
  const retrier = new Retrier<void>(
    async () => {
      // te(): Oe() == connectWorkspace; throws ApiError on 500.
      await always500({ workspaceID });
    },
    { maxRetries: 3, isRetryable: () => true, sleep: immediateSleep }
  );
  // The retrier's rejection propagates straight out. The original call site
  // did `void connect()` / an un-awaited store action, so this rejection had
  // no handler.
  await retrier.run();
}

let unhandled = 0;
const unhandledMessages: string[] = [];
process.on("unhandledRejection", (reason) => {
  unhandled += 1;
  unhandledMessages.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
});

async function main(): Promise<void> {
  console.log("=== 1) OLD buggy flow (fire-and-forget, no .catch) ===");
  // Exactly how the bug shipped: nobody awaits or catches.
  void buggyConnect(WORKSPACE_ID);
  await new Promise((r) => setTimeout(r, 50)); // let the rejection surface
  console.log(`unhandledRejections so far: ${unhandled}`);
  if (unhandled > 0) {
    console.log(`  -> ${unhandledMessages[unhandledMessages.length - 1]}`);
    console.log("  REPRODUCED: this is the production onunhandledrejection (Sentry WEB-SZ).\n");
  }

  console.log("=== 2) FIXED manager (same persistent 500) ===");
  const reports: string[] = [];
  const manager = new WorkspaceConnectionManager({
    client: always500,
    socketBaseUrl: "wss://app.runaether.dev",
    sleep: immediateSleep,
    maxRetries: 3,
    telemetry: {
      reportError: (err) => reports.push(`${err.name}: ${err.message} (status ${err.status})`),
    },
    logger: { error: () => {} },
  });

  const before = unhandled;
  // Same forgotten-.catch pattern — now provably safe.
  void manager.connect(WORKSPACE_ID);
  await new Promise((r) => setTimeout(r, 50));

  console.log(`new unhandledRejections: ${unhandled - before}`);
  console.log(`connection state: ${manager.getState()}`);
  console.log(`last error: ${manager.getLastError()?.message} (status ${manager.getLastError()?.status})`);
  console.log(`telemetry reports: ${reports.length} -> ${reports.join(", ") || "(none)"}`);

  const ok = unhandled - before === 0 && manager.getState() === "error" && reports.length === 1;
  console.log(`\n${ok ? "PASS" : "FAIL"}: fixed manager surfaces the failure with no unhandled rejection.`);
  process.exit(ok ? 0 : 1);
}

void main();
