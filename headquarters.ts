import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { controlThreadsSchema, migrationSchema } from "./nudger-contract.js";

/** A failed/absent integration has no authority to gate standalone watching. */
export function createHeadquartersPeer(bb: BbPluginApi, signal: AbortSignal) {
  let present = false;
  let ids: string[] = [];
  let refreshedAt = -Infinity;
  let refreshing: Promise<readonly string[]> | null = null;
  let requestedControls = 0;
  let completedControls = 0;
  async function refresh(): Promise<readonly string[]> {
    if (refreshing) return refreshing;
    const requested = requestedControls;
    refreshing = (async () => {
      try {
        const { plugins } = await bb.sdk.plugins.list({ signal });
        const peer = plugins.find(plugin => plugin.id === "orchestrator");
        present = !!peer && peer.enabled && ["running", "starting", "needs-configuration", "degraded"].includes(peer.status);
        if (!present) { ids = []; return ids; }
        try {
          const controls = await bb.sdk.plugins.callRpc({ pluginId: "orchestrator", method: "headquarters_controls_v1", input: { version: 1 }, outputSchema: controlThreadsSchema, signal });
          ids = controls.threadIds;
        } catch { /* Retain last known exclusions during a transient peer failure, never block unrelated threads. */ }
        return ids;
      } catch { return ids; }
      finally { refreshedAt = Date.now(); completedControls = requested; }
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }
  return {
    refresh,
    /** Every overlapping safety reader waits for discovery started after the latest reader's request. */
    async currentControls(): Promise<readonly string[]> {
      requestedControls++;
      do { await refresh(); } while (completedControls < requestedControls);
      return ids;
    },
    /** Recheck synchronously at admission: a newer discovery may start after a safety read resolves. */
    controlsPending(): boolean { return refreshing !== null || completedControls < requestedControls; },
    async controls(): Promise<readonly string[]> { return Date.now() - refreshedAt > 30_000 ? refresh() : ids; },
    contains(threadId: string): boolean { return ids.includes(threadId); },
    present(): boolean { return present; },
    readMigration(cursor: string | null) {
      return bb.sdk.plugins.callRpc({ pluginId: "orchestrator", method: "nudger_export_v1", input: { version: 1, cursor }, outputSchema: migrationSchema, signal });
    },
  };
}
