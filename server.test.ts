import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { snapshotSchema, type MigrationPage, type NudgerSnapshot } from "./nudger-contract.js";
import type { ThreadEventRow } from "./recovery-contract.js";
import { LEGACY_ACTIVATION_KEY, LEGACY_DATA_PREFIX, LEGACY_SETTINGS_KEY } from "./migration-storage.js";
import { configurationSchema } from "./rpc-contract.js";
import { statsSchema } from "./stats.js";
import type { ContinuationSnapshot } from "./continuation.js";

type PluginInfo = Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["list"]>>["plugins"][number];
type InventoryThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type FixtureThread = InventoryThread & PluginThreadEventPayloads["thread.idle"]["thread"];
function fixture(options: { settings?: Record<string, string | boolean>; headquarters?: boolean; migration?: MigrationPage; beforePlugin?(bb: BbPluginApi): void } = {}) {
  // Lifecycle-event DTOs omit inventory-only environment/activity projections.
  // These fixtures have no environment, so their list projection explicitly has no host.
  const threads: FixtureThread[] = ["worker", "headquarters"].map(id => ({
    ...makeThreadResponse({ id, projectId: "project", status: id === "worker" ? "active" : "idle" }),
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
    environmentBranchName: null, environmentHostId: null, environmentIsWorktree: null,
    environmentName: null, environmentPath: null, environmentProviderId: null, environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false, queuedWork: "none", pinSortKey: null,
  }));
  const history = new Map<string, ThreadEventRow[]>([["worker", [{ id: "start", threadId: "worker", seq: 1, createdAt: 1, scope: { kind: "turn", turnId: "run" }, type: "turn/started", data: { providerThreadId: "provider" } }]]]);
  const controls: { present: boolean; enabled: boolean; status: PluginInfo["status"]; ids: string[]; sends: number; readControls?: () => Promise<string[]> } = { present: options.headquarters ?? false, enabled: true, status: "running", ids: ["headquarters"], sends: 0 };
  const installed: PluginInfo = {
    id: "orchestrator", name: "Headquarters", description: "Fixture", enabled: true, status: "running", statusDetail: null, version: "0.2.0",
    app: { hasApp: true, bundle: null }, capabilities: [], cliCommand: null, collections: [], handlerStats: { count: 0, errorCount: 0, maxMs: 0, totalMs: 0 },
    hasSettings: true, icon: null, iconUrl: null, icons: {}, isOrphanedBuiltin: false, logoDarkUrl: null, logoUrl: null, provenance: "direct",
    providerIds: [], publisherLabel: null, rootDir: "/fixture/headquarters", schedules: [], screenshots: [], services: [], source: "path:/fixture/headquarters", sourceDisplay: "Fixture", updateState: {},
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "nudger", settings: options.settings, sdk: {
    plugins: {
      list: async () => ({ plugins: controls.present ? [{ ...installed, enabled: controls.enabled, status: controls.status }] : [] }),
      callRpc: async args => {
        if (!controls.present) throw new Error("Headquarters removed");
        if (args.method === "headquarters_controls_v1") return args.outputSchema.parse({ version: 1, threadIds: controls.readControls ? await controls.readControls() : controls.ids });
        if (args.method === "nudger_export_v1") return args.outputSchema.parse(options.migration ?? { version: 1, entries: [], settings: {}, nextCursor: null });
        throw new Error("Unknown fixture public method");
      },
    },
    projects: { list: async () => [{ id: "project", name: "Fixture project" }] },
    threads: {
      list: async ({ offset = 0, limit = 100 } = {}) => threads.slice(offset, offset + limit),
      get: async ({ threadId }) => { const thread = threads.find(row => row.id === threadId); if (!thread) throw new Error("Unknown thread"); return thread; },
      getPluginMetadata: async () => ({}),
      events: { list: async args => {
        const rows = (history.get(args.threadId) ?? []).filter(row => row.seq > Number(args.afterSeq ?? -1) && row.seq < Number(args.beforeSeq ?? Infinity) && (!args.types || args.types.includes(row.type)));
        return (args.order === "desc" ? [...rows].reverse() : rows).slice(0, Number(args.limit ?? 100));
      } },
      send: async () => { controls.sends++; throw new Error("No project message is permitted by this fixture"); },
      queuedMessages: { delete: async () => ({ ok: true as const }) },
    },
  } });
  options.beforePlugin?.(bb);
  plugin(bb);
  const snapshot = async (): Promise<NudgerSnapshot> => snapshotSchema.parse(await harness.callRpc("nudger_snapshot_v1", { version: 1 }));
  const dispatch = async (context: ReturnType<typeof makeMessageDispatchHookContext>) => harness.registrations.hooks["message.dispatch"]!(context);
  async function finish(text = "Still implementing the assigned work.") {
    const seq = Math.max(0, ...(history.get("worker") ?? []).map(row => row.seq));
    history.get("worker")!.push(
      { id: "message", threadId: "worker", seq: seq + 1, createdAt: Date.now(), scope: { kind: "turn", turnId: "run" }, type: "item/completed", data: { providerThreadId: "provider", item: { id: "final", type: "agentMessage", text } } },
      { id: "complete", threadId: "worker", seq: seq + 2, createdAt: Date.now(), scope: { kind: "turn", turnId: "run" }, type: "turn/completed", data: { providerThreadId: "provider", status: "completed" } },
    );
    threads[0]!.status = "idle"; threads[0]!.updatedAt++;
    await harness.emitThreadEvent("thread.idle", { thread: threads[0]!, lastAssistantText: "Not authoritative evidence" });
  }
  async function until(predicate: (value: NudgerSnapshot) => boolean): Promise<NudgerSnapshot> {
    for (let attempt = 0; attempt < 100; attempt++) { const value = await snapshot(); if (predicate(value)) return value; await nextTurn(); }
    throw new Error("Expected live producer state did not arrive");
  }
  return { bb, harness, threads, history, controls, snapshot, dispatch, finish, until };
}
function jevResponse(classification: "continue" | "blocker" | "finished") {
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {
    obstacle: { type: "choice", choice: classification === "blocker" ? "blocker" : "none", confidence: 1, probabilities: { none: classification === "blocker" ? 0 : 1, blocker: classification === "blocker" ? 1 : 0, permission: 0, uncertainty: 0 } },
    boundary: { type: "choice", choice: classification === "finished" ? "finished" : "continue", confidence: 1, probabilities: { continue: classification === "finished" ? 0 : 1, finished: classification === "finished" ? 1 : 0, uncertainty: 0 } },
  }, usage: { input_tokens: 42, output_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
}

test("standalone factory watches with zero setup and none never calls a model or dispatches", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Default must not call a paid detector"); });
  const h = fixture(); t.after(() => h.harness.dispose());
  const service = h.harness.runService("nudger-watcher-v1");
  const initial = await h.snapshot();
  assert.equal(initial.status.observing, true); assert.equal(initial.status.classifying, false); assert.equal(initial.status.detectorId, null);
  assert.equal(initial.status.threads.length, 2); assert.equal(initial.status.watchedCount, 1);
  await h.finish();
  const ending = await h.until(value => value.records.length === 1);
  assert.equal(ending.records[0]!.action, "suppressed"); assert.notEqual(ending.historyVersion, initial.historyVersion);
  assert.equal(fetch.mock.callCount(), 0); assert.equal(h.controls.sends, 0);
  service.controller.abort(); await service.done;
  assert.equal(h.controls.sends, 0);
});

test("factory migration restores pause, per-thread off and lifetime count through reload without exposing or calling the key", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Paused migration cannot classify"); });
  const h = fixture({ headquarters: true, migration: { version: 1, entries: [
    { key: "recovery.paused", value: true }, { key: "continuation.off.worker", value: true }, { key: "continuation.sentCounts", value: { worker: 19 } },
    { key: "usage.detector.jev.2026-10-01", value: { requests: 7, errors: 0, inputTokens: 400, outputTokens: 30 } }, { key: "usage.detector.backfilled", value: "2026-10-01" },
    { key: "recovery.records.legacy", value: { id: "legacy", threadId: "worker", projectId: "project", runId: "old-run", messageId: "old-message", messageRevision: 1, observedAt: Date.now(), classification: "finished", action: "finished", reason: "Legacy finished ending", detector: null, judgment: null } },
    { key: "continuation.nudge.worker", value: { nudgeId: "old", threadId: "worker", runId: "old-run", messageId: "old-message", messageRevision: 1, createdAt: 1, sendAt: 2, state: "pending", cancelReason: null } },
  ], settings: { detector: "jev", typesafeApiKey: "fixture-key-secret" }, nextCursor: null } });
  let current = h.harness; t.after(() => current.dispose());
  const value = await h.snapshot();
  assert.equal(value.status.paused, true); assert.equal(value.status.classifying, false);
  assert.equal(value.jevUsage?.days["2026-10-01"]?.requests, 7);
  assert.equal(value.records[0]?.id, "legacy"); assert.equal(value.records[0]?.action, "finished");
  const decisions = await current.runCli(["continuation", "worker"]);
  assert.deepEqual(JSON.parse(decisions.stdout).pending, []);
  assert.equal(JSON.stringify(value).includes("fixture-key-secret"), false);
  const banner = await current.callRpc("nudger_continuation_status_v1", { threadId: "worker" });
  assert.deepEqual(banner && typeof banner === "object" ? { state: Reflect.get(banner, "state"), count: Reflect.get(banner, "nudgeCount") } : null, { state: "off", count: 19 });
  const replacement = await current.reload(plugin); current = replacement.harness;
  const restored = snapshotSchema.parse(await current.callRpc("nudger_snapshot_v1", { version: 1 }));
  assert.equal(restored.status.paused, true); assert.equal(restored.jevUsage?.days["2026-10-01"]?.requests, 7);
  assert.equal(restored.records[0]?.id, "legacy"); assert.equal(restored.records[0]?.action, "finished");
  assert.equal(fetch.mock.callCount(), 0); assert.equal(h.controls.sends, 0);
});

test("Jev classifies without a machine or Headquarters; a user dispatch cancels its pending nudge and unknown owned submissions and queues fail closed", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => jevResponse("continue"));
  const h = fixture({ settings: { detector: "jev", typesafeApiKey: "fake-offline-key" } }); t.after(() => h.harness.dispose());
  await h.snapshot(); await h.finish();
  await h.until(value => value.records[0]?.action === "nudged");
  const pending = await h.harness.runCli(["continuation", "worker"]);
  assert.match(pending.stdout, /"state": "pending"/);
  assert.deepEqual(await h.dispatch(makeMessageDispatchHookContext({ thread: { id: "worker", status: "idle" }, initiator: "user", senderThreadId: null, experimental_submission: null })), { action: "proceed" });
  const cancelled = await h.harness.runCli(["continuation", "worker"]);
  assert.match(cancelled.stdout, /fresh activity before admission: user/);
  const stale = await h.dispatch(makeMessageDispatchHookContext({ thread: { id: "worker", status: "idle" }, queuedMessages: [makeQueueEntry({ originPluginId: "nudger", threadId: "worker" })] }));
  assert.equal(stale.action, "reject"); assert.equal(fetch.mock.callCount(), 1); assert.equal(h.controls.sends, 0);
  const unrecognized = await h.dispatch(makeMessageDispatchHookContext({ thread: { id: "worker", status: "idle" }, experimental_submission: { pluginId: "nudger", data: {} } }));
  assert.equal(unrecognized.action, "reject");
  assert.equal(h.harness.sdk.calls.some(call => call.path.startsWith("hosts.")), false);
});

test("Headquarters chat inline and queued rows remain admitted; current control IDs exclude Nudger submissions", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => jevResponse("continue"));
  const h = fixture({ headquarters: true, settings: { detector: "jev", typesafeApiKey: "offline-key" } }); t.after(() => h.harness.dispose());
  await h.snapshot();
  const chat = makeMessageDispatchHookContext({ thread: { id: "headquarters", status: "idle" }, experimental_submission: { pluginId: "orchestrator", data: {} }, queuedMessages: [] });
  assert.deepEqual(await h.dispatch(chat), { action: "proceed" });
  assert.deepEqual(await h.dispatch(makeMessageDispatchHookContext({ ...chat, queuedMessages: [makeQueueEntry({ threadId: "headquarters", originPluginId: "orchestrator" })] })), { action: "proceed" });
  await h.finish(); await h.until(value => value.records[0]?.action === "nudged");
  h.controls.ids.push("worker");
  const currentControl = await h.dispatch(makeMessageDispatchHookContext({ thread: { id: "worker", status: "idle" }, experimental_submission: { pluginId: "nudger", data: { continuationNudge: "old" } } }));
  assert.equal(currentControl.action, "reject"); assert.equal(fetch.mock.callCount(), 1); assert.equal(h.controls.sends, 0);
  h.controls.present = false;
  assert.deepEqual(await h.dispatch(makeMessageDispatchHookContext({ thread: { id: "headquarters", status: "idle" }, initiator: "user" })), { action: "proceed" });
});

test("native Stop suppresses further endings until admitted human work", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => jevResponse("continue"));
  const h = fixture({ settings: { detector: "jev", typesafeApiKey: "offline-key" } }); t.after(() => h.harness.dispose());
  await h.snapshot();
  h.history.get("worker")!.push({ id: "stop", threadId: "worker", seq: 2, createdAt: Date.now(), scope: { kind: "thread" }, type: "system/thread/interrupted", data: { reason: "manual-stop" } });
  await h.harness.emitThreadEvent("experimental_thread.events", { thread: h.threads[0]!, sequence: 2 });
  assert.match((await h.snapshot()).status.threads.find(thread => thread.id === "worker")!.exclusion!, /manual Stop/);
  await h.finish("Current work remains unfinished after Stop.");
  assert.equal((await h.snapshot()).records.length, 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(await h.dispatch(makeMessageDispatchHookContext({ thread: { id: "worker", status: "idle" }, initiator: "user", senderThreadId: null, experimental_submission: null })), { action: "proceed" });
  assert.equal((await h.snapshot()).status.threads.find(thread => thread.id === "worker")!.exclusion, null);
  assert.equal(h.controls.sends, 0);
});

test("active blocker publication revalidates current public history instead of replaying old reported records", async t => {
  t.mock.method(globalThis, "fetch", async () => jevResponse("blocker"));
  const h = fixture({ settings: { detector: "jev", typesafeApiKey: "offline-key" } }); t.after(() => h.harness.dispose());
  await h.snapshot(); await h.finish("Required credential is unavailable.");
  const live = await h.until(value => value.records[0]?.action === "reported" && value.blockers.length === 1);
  assert.equal(live.blockers[0]!.kind, "blocker");
  h.history.get("worker")!.push({ id: "next", threadId: "worker", seq: 4, createdAt: 4, scope: { kind: "turn", turnId: "next-run" }, type: "turn/started", data: { providerThreadId: "provider" } });
  h.threads[0]!.status = "active"; h.threads[0]!.updatedAt++;
  // No lifecycle announcement: the producer must re-read public current state before publishing.
  const advanced = await h.snapshot();
  assert.equal(advanced.blockers.length, 0); assert.equal(advanced.records[0]!.action, "reported");
  assert.equal(h.controls.sends, 0);
});

test("a still-current reported obstacle survives a plugin reload with its own final message", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => jevResponse("blocker"));
  const h = fixture({ settings: { detector: "jev", typesafeApiKey: "offline-key" } });
  let current = h.harness; t.after(() => current.dispose());
  await h.snapshot(); await h.finish("Required credential is unavailable.");
  await h.until(value => value.blockers.length === 1);
  const replacement = await current.reload(plugin); current = replacement.harness;
  const restored = snapshotSchema.parse(await current.callRpc("nudger_snapshot_v1", { version: 1 }));
  assert.deepEqual(restored.blockers.map(blocker => [blocker.threadId, blocker.kind, blocker.finalAssistantMessage]), [["worker", "blocker", "Required credential is unavailable."]]);
  assert.equal(fetch.mock.callCount(), 1); assert.equal(h.controls.sends, 0);
});

test("factory loading rejects owned submissions, while an unavailable legacy key keeps classification gated", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Missing key must never call a model"); });
  const h = fixture({ headquarters: true, migration: { version: 1, entries: [], settings: { detector: "jev" }, nextCursor: null } }); t.after(() => h.harness.dispose());
  const loading = await h.dispatch(makeMessageDispatchHookContext({ experimental_submission: { pluginId: "nudger", data: { continuationNudge: "stale" } } }));
  assert.equal(loading.action, "reject");
  const value = await h.snapshot(); assert.equal(value.status.classifying, false); assert.equal(value.status.detectorId, null);
  assert.match(value.status.gates.join(" "), /enter your TypeSafe key.*explicitly select Jev/);
  assert.equal(fetch.mock.callCount(), 0); assert.equal(h.controls.sends, 0);
});

test("a removed Luna choice reads as none behind a clear gate, never classifies, and Luna-era history stays readable", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("A removed detector must never call a model"); });
  const lunaRecord = { id: "legacy-luna", threadId: "worker", projectId: "project", runId: "old-run", messageId: "old-message", messageRevision: 1, observedAt: Date.now() - 60_000,
    classification: "blocker", action: "reported", reason: "Legacy obstacle", detector: "cassidy-codex-gpt-6-luna-medium-fast",
    judgment: { classification: "blocker", model: "gpt-6-luna", latencyMs: 5, usage: { inputTokens: 100, outputTokens: 5, cost: null }, confidence: null, probabilities: null, questions: null } };
  const migrations: MigrationPage[] = [
    { version: 1, entries: [], settings: { detector: "luna", hostId: "legacy-host" }, nextCursor: null },
    { version: 1, entries: [{ key: "recovery.records.legacy-luna", value: lunaRecord }], settings: {}, nextCursor: null },
  ];
  for (const migration of migrations) {
    const h = fixture({ headquarters: true, migration, settings: { detector: "luna" } }); t.after(() => h.harness.dispose());
    const value = await h.snapshot();
    assert.equal(value.status.classifying, false); assert.equal(value.status.detectorId, null);
    assert.match(value.status.gates.join(" "), /Luna was removed; select Jev/);
    const config = configurationSchema.parse(await h.harness.callRpc("nudger_settings_v1", { version: 1 }));
    assert.equal(config.detector, "none"); assert.match(config.error ?? "", /Luna was removed; select Jev/);
    if (migration.settings.detector) assert.deepEqual(await h.bb.storage.kv.get(LEGACY_SETTINGS_KEY), { detector: "luna", keyAvailable: false });
    if (migration.entries.length) {
      assert.equal(value.records.find(record => record.id === "legacy-luna")?.detector, lunaRecord.detector);
      const stats = statsSchema.parse(await h.harness.callRpc("nudger_stats_v1", { version: 1 }));
      // A retained obstacle whose recorded message is no longer confirmable is history, not current attention.
      assert.deepEqual(stats.attention, []);
      assert.equal(stats.jev?.series.month.some(point => point.requests > 0), false);
    }
    await h.finish(); assert.equal((await h.snapshot()).status.classifying, false);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("stats report Jev usage and a live obstacle from the same records Headquarters reads", async t => {
  t.mock.method(globalThis, "fetch", async () => jevResponse("blocker"));
  const h = fixture({ settings: { detector: "jev", typesafeApiKey: "offline-key" } }); t.after(() => h.harness.dispose());
  await h.snapshot(); await h.finish("**Required credential** is unavailable, so the deploy cannot continue.");
  await h.until(value => value.blockers.length === 1);
  const stats = statsSchema.parse(await h.harness.callRpc("nudger_stats_v1", { version: 1 }));
  assert.equal(stats.attention.length, 1);
  assert.deepEqual({ ...stats.attention[0]!, observedAt: 0 }, { id: stats.attention[0]!.id, threadId: "worker", projectId: "project", title: h.threads[0]!.title ?? h.threads[0]!.titleFallback ?? "worker", project: "Fixture project",
    kind: "blocker", observedAt: 0, summary: "Required credential is unavailable, so the deploy cannot continue." });
  const today = stats.jev!.series.day.at(-1)!;
  assert.equal(today.requests, 1); assert.equal(today.inputTokens, 42); assert.equal(today.costUsd, 42 * 0.042 / 1_000_000);
  assert.equal(stats.nudges.series.day.at(-1)!.nudges, 0); assert.equal(stats.nudges.recent.length, 0);
  assert.equal(h.controls.sends, 0);
});

test("a partial migration cannot activate imported paid settings before the old pause and toggles are restored", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Partial policy restoration must stay passive"); });
  const h = fixture({ headquarters: true, migration: { version: 1, entries: [], settings: { detector: "jev", typesafeApiKey: "offline-key" }, nextCursor: "later-page" } }); t.after(() => h.harness.dispose());
  const value = await h.snapshot();
  assert.equal(value.status.observing, true); assert.equal(value.status.classifying, false);
  assert.match(value.status.gates.join(" "), /migration is incomplete/);
  await h.finish(); assert.equal((await h.snapshot()).records[0]?.action, "suppressed");
  assert.equal(fetch.mock.callCount(), 0); assert.equal(h.controls.sends, 0);
});

test("producer historyVersion changes when a judgment completes on the same record ID", async t => {
  const completion = Promise.withResolvers<void>();
  t.mock.method(globalThis, "fetch", async () => { await completion.promise; return jevResponse("finished"); });
  const h = fixture({ settings: { detector: "jev", typesafeApiKey: "offline-key" } }); t.after(() => h.harness.dispose());
  await h.snapshot(); await h.finish();
  const pending = await h.until(value => value.records[0]?.action === "observed");
  completion.resolve();
  const finished = await h.until(value => value.records[0]?.action === "finished");
  assert.equal(finished.records[0]!.id, pending.records[0]!.id);
  assert.notEqual(finished.historyVersion, pending.historyVersion);
  assert.equal((await h.snapshot()).historyVersion, finished.historyVersion);
  assert.equal(h.controls.sends, 0);
});

test("selecting a generic Headquarters conversation while running excludes its next ending before a discovery tick", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => jevResponse("continue"));
  const h = fixture({ headquarters: true, settings: { detector: "jev", typesafeApiKey: "offline-key" } }); t.after(() => h.harness.dispose());
  h.threads[0]!.originPluginId = null;
  assert.equal((await h.snapshot()).status.classifying, true);
  h.controls.ids.push("worker");
  await h.finish();
  const excluded = await h.until(value => value.records[0]?.action === "suppressed");
  assert.match(excluded.records[0]!.reason!, /control conversation before classification/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(h.controls.sends, 0);
  assert.doesNotMatch((await h.harness.runCli(["continuation", "worker"])).stdout, /"state": "pending"/);
});

test("a safety read does not reuse discovery started before a Headquarters selection change", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => jevResponse("continue"));
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const h = fixture({ headquarters: true, settings: { detector: "jev", typesafeApiKey: "offline-key" } });
  t.after(async () => { release.resolve(); await h.harness.dispose(); });
  h.threads[0]!.originPluginId = null;
  await h.snapshot();
  let first = true;
  h.controls.readControls = async () => {
    const ids = [...h.controls.ids];
    if (first) { first = false; started.resolve(); await release.promise; }
    return ids;
  };
  const admission = h.dispatch(makeMessageDispatchHookContext({ thread: { id: "worker", status: "idle" }, experimental_submission: { pluginId: "nudger", data: {} } }));
  await started.promise;
  h.controls.ids.push("worker");
  await h.finish();
  release.resolve();
  assert.equal((await admission).action, "reject");
  const excluded = await h.until(value => value.records[0]?.action === "suppressed");
  assert.match(excluded.records[0]!.reason!, /control conversation before classification/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(h.controls.sends, 0);
});

test("a recognized nudge waits for newer control discovery before dispatch admission", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => jevResponse("continue"));
  const firstStarted = Promise.withResolvers<void>(), firstRelease = Promise.withResolvers<void>();
  const currentStarted = Promise.withResolvers<void>(), currentRelease = Promise.withResolvers<void>();
  const h = fixture({ headquarters: true, settings: { detector: "jev", typesafeApiKey: "offline-key" } });
  t.after(async () => { firstRelease.resolve(); currentRelease.resolve(); await h.harness.dispose(); });
  h.threads[0]!.originPluginId = null;
  await h.snapshot(); await h.finish(); await h.until(value => value.records[0]?.action === "nudged");
  const { pending } = JSON.parse((await h.harness.runCli(["continuation", "worker"])).stdout) as ContinuationSnapshot;
  assert.equal(pending.length, 1);
  const nudgeId = pending[0]!.nudgeId;
  let reads = 0, settled = false;
  h.controls.readControls = async () => {
    const ids = [...h.controls.ids];
    reads++;
    if (reads === 1) { firstStarted.resolve(); await firstRelease.promise; }
    if (reads === 2) { currentStarted.resolve(); await currentRelease.promise; }
    return ids;
  };
  const admission = h.dispatch(makeMessageDispatchHookContext({ thread: { id: "worker", status: "idle" },
    experimental_submission: { pluginId: "nudger", data: { continuationNudge: nudgeId } } })).then(decision => { settled = true; return decision; });
  await firstStarted.promise;
  h.controls.ids.push("worker");
  const selectedBanner = h.harness.callRpc("nudger_continuation_status_v1", { threadId: "worker" });
  // A later non-mutating read confirms the nudge remains valid while control discovery is blocked.
  const blocked = JSON.parse((await h.harness.runCli(["continuation", "worker"])).stdout) as ContinuationSnapshot;
  assert.equal(blocked.pending[0]?.nudgeId, nudgeId);
  firstRelease.resolve();
  await currentStarted.promise;
  assert.equal(settled, false);
  currentRelease.resolve();
  const decision = await admission;
  assert.equal(decision.action, "reject");
  await selectedBanner;
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(h.controls.sends, 0);
});

test("Headquarters selection during classification discards the result before continuation routing", async t => {
  const started = Promise.withResolvers<void>(), completion = Promise.withResolvers<void>();
  const fetch = t.mock.method(globalThis, "fetch", async () => { started.resolve(); await completion.promise; return jevResponse("continue"); });
  const h = fixture({ headquarters: true, settings: { detector: "jev", typesafeApiKey: "offline-key" } });
  t.after(async () => { completion.resolve(); await h.harness.dispose(); });
  h.threads[0]!.originPluginId = null;
  await h.snapshot(); await h.finish(); await started.promise;
  h.controls.ids.push("worker");
  completion.resolve();
  const excluded = await h.until(value => value.records[0]?.action === "suppressed");
  assert.match(excluded.records[0]!.reason!, /control conversation before routing/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(h.controls.sends, 0);
  assert.doesNotMatch((await h.harness.runCli(["continuation", "worker"])).stdout, /"state": "pending"/);
});

test("foreign plugins cannot mutate settings, secrets, enablement, pause, toggles or cancellation before any producer reads", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Foreign plugins cannot activate paid classification"); });
  const h = fixture({ settings: { detector: "none", typesafeApiKey: "operator-secret" } });
  t.after(() => h.harness.dispose());
  const foreign = { experimental_caller: { kind: "plugin" as const, pluginId: "unrelated" } };
  for (const input of [
    { version: 1, enabled: true, detector: "jev" }, { version: 1, typesafeApiKey: "foreign-secret" },
  ]) await assert.rejects(h.harness.callRpc("nudger_settings_set_v1", input, foreign), /native operator/);
  await assert.rejects(h.harness.callRpc("nudger_continuation_toggle_v1", { threadId: "worker", enabled: false }, foreign), /native operator/);
  await assert.rejects(h.harness.callRpc("nudger_continuation_cancel_v1", { threadId: "worker" }, foreign), /native operator/);
  await assert.rejects(h.harness.callRpc("nudger_pause_v1", { version: 1, paused: false }, foreign), /Only Headquarters/);
  assert.deepEqual(h.harness.sdk.calls, []);
  assert.deepEqual(await h.bb.storage.kv.list(), []);
  const settings = configurationSchema.parse(await h.harness.callRpc("nudger_settings_v1", { version: 1 }, foreign));
  assert.equal(settings.detector, "none"); assert.equal(settings.keyConfigured, true);
  assert.equal((await h.snapshot()).status.classifying, false);
  await h.harness.callRpc("nudger_history_v1", { version: 1 }, foreign);
  await h.harness.callRpc("nudger_continuation_status_v1", { threadId: "worker" }, foreign);
  await h.harness.callRpc("nudger_stats_v1", { version: 1 }, foreign);
  await h.harness.callRpc("nudger_pause_v1", { version: 1, paused: true }, { experimental_caller: { kind: "plugin", pluginId: "orchestrator" } });
  await h.harness.callRpc("nudger_pause_v1", { version: 1, paused: false });
  await h.finish(); assert.equal(fetch.mock.callCount(), 0); assert.equal(h.controls.sends, 0);
});

test("foreign toggle and cancel cannot alter an operator-owned pending decision", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => jevResponse("continue"));
  const h = fixture({ settings: { detector: "jev", typesafeApiKey: "operator-key" } });
  t.after(() => h.harness.dispose());
  await h.snapshot(); await h.finish(); await h.until(value => value.records[0]?.action === "nudged");
  const before = await h.harness.runCli(["continuation", "worker"]);
  const foreign = { experimental_caller: { kind: "plugin" as const, pluginId: "unrelated" } };
  await assert.rejects(h.harness.callRpc("nudger_continuation_cancel_v1", { threadId: "worker" }, foreign), /native operator/);
  await assert.rejects(h.harness.callRpc("nudger_continuation_toggle_v1", { threadId: "worker", enabled: false }, foreign), /native operator/);
  const after = await h.harness.runCli(["continuation", "worker"]);
  assert.deepEqual(JSON.parse(after.stdout).pending, JSON.parse(before.stdout).pending);
  assert.equal(JSON.parse(after.stdout).enabled, JSON.parse(before.stdout).enabled);
  assert.deepEqual(JSON.parse(after.stdout).log, JSON.parse(before.stdout).log);
  assert.equal(fetch.mock.callCount(), 1); assert.equal(h.controls.sends, 0);
  await h.harness.callRpc("nudger_continuation_cancel_v1", { threadId: "worker" });
  assert.doesNotMatch((await h.harness.runCli(["continuation", "worker"])).stdout, /"state": "pending"/);
});

test("late import shares the mutation lane while standard BB settings remain independently authoritative", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Concurrent explicit none must remain passive"); });
  for (const gate of ["marker", "preferences"] as const) {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const migration: MigrationPage = { version: 1, entries: [
      { key: "recovery.paused", value: false }, { key: "continuation.off.worker", value: false },
      { key: "continuation.off.headquarters", value: false }, { key: "continuation.sentCounts", value: { worker: 13 } },
    ], settings: { detector: "jev", typesafeApiKey: "legacy-secret", hostId: "legacy-host" }, nextCursor: null };
    const h = fixture({ migration });
    t.after(async () => { release.resolve(); await h.harness.dispose(); });
    const service = h.harness.runService("nudger-watcher-v1");
    await h.snapshot(); await nextTurn();
    await h.finish();
    const ownRecord = (await h.until(value => value.records.length === 1)).records[0]!;
    migration.entries.push(
      { key: `recovery.records.${ownRecord.id}`, value: { ...ownRecord, reason: "Older imported reason" } },
      { key: "recovery.records.legacy-only", value: { ...ownRecord, id: "legacy-only", reason: "Imported retained history" } },
    );
    const set = h.bb.storage.kv.set.bind(h.bb.storage.kv);
    h.bb.storage.kv.set = async (key, value) => {
      if (key === (gate === "marker" ? LEGACY_ACTIVATION_KEY : `${LEGACY_DATA_PREFIX}recovery.paused`)) { entered.resolve(); await release.promise; }
      return set(key, value);
    };
    h.controls.present = true;
    t.mock.timers.tick(30_000);
    await entered.promise;
    // Native standard settings writes bypass plugin RPC and its serial lane.
    await h.harness.setSettings({ detector: "none", enabled: false, typesafeApiKey: "native-new-secret" });
    const settingsWrite = h.harness.callRpc("nudger_settings_set_v1", { version: 1, detector: "none", enabled: false, typesafeApiKey: "rpc-new-secret" });
    const pause = h.harness.callRpc("nudger_pause_v1", { version: 1, paused: true });
    const bridgePause = h.harness.callRpc("nudger_pause_v1", { version: 1, paused: true }, { experimental_caller: { kind: "plugin", pluginId: "orchestrator" } });
    const toggle = h.harness.callRpc("nudger_continuation_toggle_v1", { threadId: "worker", enabled: false });
    const cli = h.harness.runCli(["continuation", "headquarters", "off"]);
    const cancel = h.harness.callRpc("nudger_continuation_cancel_v1", { threadId: "worker" });
    release.resolve();
    await Promise.all([settingsWrite, pause, bridgePause, toggle, cli, cancel]);
    const config = configurationSchema.parse(await h.harness.callRpc("nudger_settings_v1", { version: 1 }));
    assert.equal(config.detector, "none"); assert.equal(config.enabled, false); assert.equal(config.paused, true);
    assert.equal(await h.bb.storage.kv.get("recovery.paused"), true);
    assert.equal(await h.bb.storage.kv.get("continuation.off.worker"), true);
    assert.equal(await h.bb.storage.kv.get("continuation.off.headquarters"), true);
    assert.equal(await h.bb.storage.kv.get(`${LEGACY_DATA_PREFIX}recovery.paused`), false);
    assert.deepEqual(await h.bb.storage.kv.get(LEGACY_SETTINGS_KEY), { detector: "jev", keyAvailable: true });
    const banner = await h.harness.callRpc("nudger_continuation_status_v1", { threadId: "worker" });
    assert.equal(banner && typeof banner === "object" ? Reflect.get(banner, "nudgeCount") : null, 13);
    assert.match((await h.harness.runCli(["continuation", "worker"])).stdout, /"enabled": false/);
    await h.finish(); assert.equal((await h.snapshot()).status.classifying, false);
    const retained = await h.snapshot();
    assert.equal(retained.records.find(record => record.id === ownRecord.id)?.reason, ownRecord.reason);
    assert.equal(retained.records.find(record => record.id === "legacy-only")?.reason, "Imported retained history");
    for (const key of await h.bb.storage.kv.list()) assert.doesNotMatch(JSON.stringify(await h.bb.storage.kv.get(key)), /legacy-secret|native-new-secret|rpc-new-secret/);
    service.controller.abort(); await service.done;
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("a direct BB write fences an old configure read across awaits and immediately revokes paid configuration", async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Stale settings cannot activate a model"); });
  const h = fixture({ settings: { detector: "jev", typesafeApiKey: "old-key" }, beforePlugin(bb) {
    const get = bb.storage.kv.get.bind(bb.storage.kv);
    let first = true;
    bb.storage.kv.get = async <T>(key: string): Promise<T | undefined> => {
      const captured = await get<T>(key);
      if (first && key === LEGACY_SETTINGS_KEY) { first = false; entered.resolve(); await release.promise; }
      return captured;
    };
  } });
  t.after(async () => { release.resolve(); await h.harness.dispose(); });
  const loading = h.snapshot();
  await entered.promise;
  await h.harness.setSettings({ detector: "none", enabled: false, typesafeApiKey: "new-key" });
  release.resolve(); await loading;
  const config = configurationSchema.parse(await h.harness.callRpc("nudger_settings_v1", { version: 1 }));
  assert.equal(config.detector, "none"); assert.equal(config.enabled, false);
  await h.finish();
  assert.equal((await h.snapshot()).status.classifying, false);
  assert.equal(fetch.mock.callCount(), 0); assert.equal(h.controls.sends, 0);
});

test("a fresh operator message durably overrides an imported Stop without modifying the legacy baseline", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No detector was selected"); });
  const h = fixture({ headquarters: true, migration: { version: 1, entries: [
    { key: "recovery.stopped.worker", value: true },
  ], settings: {}, nextCursor: null } });
  let current = h.harness; t.after(() => current.dispose());
  assert.match((await h.snapshot()).status.threads.find(thread => thread.id === "worker")!.exclusion!, /manual Stop/);
  await h.dispatch(makeMessageDispatchHookContext({ thread: { id: "worker", status: "active" }, initiator: "user", senderThreadId: null, experimental_submission: null }));
  const replacement = await current.reload(plugin); current = replacement.harness;
  const restored = snapshotSchema.parse(await current.callRpc("nudger_snapshot_v1", { version: 1 }));
  assert.equal(restored.status.threads.find(thread => thread.id === "worker")!.exclusion, null);
  assert.equal(await replacement.bb.storage.kv.get("recovery.stopped.worker"), false);
  assert.equal(await replacement.bb.storage.kv.get(`${LEGACY_DATA_PREFIX}recovery.stopped.worker`), true);
  assert.equal(fetch.mock.callCount(), 0);
});
