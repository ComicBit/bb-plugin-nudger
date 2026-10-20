import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { migrateHeadquarters, MIGRATION_KEY } from "./migration.js";
import { migrationSchema, type MigrationPage } from "./nudger-contract.js";
import { LEGACY_ACTIVATION_KEY, LEGACY_DATA_PREFIX, LEGACY_SETTINGS_KEY, LEGACY_SENT_KEY, LEGACY_USAGE_PREFIX, retainedValue } from "./migration-storage.js";
import { createContinuation } from "./continuation.js";
import { createUsageLedger } from "./detector-usage.js";
import type { RecoveryRecord } from "./recovery-contract.js";

function fixture(initial: { detector?: string; typesafeApiKey?: string } = {}) {
  const { bb, harness } = createFakePluginHost({ settings: initial });
  const settings = bb.settings.define({
    detector: { type: "select", label: "Detector", options: ["none", "jev"] },
    typesafeApiKey: { type: "string", label: "API key", secret: true },
  });
  return { bb, harness, settings };
}
const page = (entries: MigrationPage["entries"], nextCursor: string | null = null): MigrationPage => ({ version: 1, entries, nextCursor, settings: { detector: "jev", typesafeApiKey: "fixture-secret-not-for-model-calls", hostId: "selected-machine" } });

test("migration preserves immutable history and preferences without copying a key or replaying pending decisions", async t => {
  const h = fixture(); t.after(() => h.harness.dispose());
  const legacy = page([
    { key: "recovery.paused", value: true }, { key: "continuation.off.thread", value: true },
    { key: "continuation.sentCounts", value: { thread: 17 } },
    { key: "usage.detector.jev.2026-10-01", value: { requests: 23, errors: 2, inputTokens: 400, outputTokens: 20 } },
    { key: "usage.detector.backfilled", value: "2026-10-01" },
    { key: "continuation.nudge.thread", value: { nudgeId: "old", threadId: "thread", runId: "run", messageId: "message", messageRevision: 2, createdAt: 1000, sendAt: 2000, state: "pending", cancelReason: null } },
  ]);
  let reads = 0;
  const options = { store: h.bb.storage.kv, settings: h.settings, readPage: async () => { reads++; return legacy; } };
  assert.equal(await migrateHeadquarters(options), true);
  assert.equal(await retainedValue(h.bb.storage.kv, "recovery.paused"), true);
  assert.equal(await h.bb.storage.kv.get("recovery.paused"), undefined);
  assert.deepEqual(await h.bb.storage.kv.get(LEGACY_SENT_KEY), { thread: 17 });
  assert.deepEqual(await h.bb.storage.kv.get(`${LEGACY_USAGE_PREFIX}jev.2026-10-01`), { requests: 23, errors: 2, inputTokens: 400, outputTokens: 20 });
  const nudge = await retainedValue<{ state: string; cancelReason: string }>(h.bb.storage.kv, "continuation.nudge.thread");
  assert.equal(nudge?.state, "cancelled"); assert.match(nudge!.cancelReason, /without replaying/);
  assert.equal((await h.settings.get()).typesafeApiKey, undefined);
  // Headquarters' former machine choice is not retained.
  assert.deepEqual(await h.bb.storage.kv.get(LEGACY_SETTINGS_KEY), { detector: "jev", keyAvailable: true });
  for (const key of await h.bb.storage.kv.list()) assert.equal(JSON.stringify(await h.bb.storage.kv.get(key)).includes("fixture-secret"), false);
  assert.equal(await migrateHeadquarters(options), false); assert.equal(reads, 1);
  const originalNudge = legacy.entries.at(-1)!.value;
  assert.ok(originalNudge !== null && typeof originalNudge === "object" && !Array.isArray(originalNudge));
  assert.equal(originalNudge.state, "pending");
});

test("a crash after one entry resumes the same page without double-counting or checkpointing an incomplete copy", async t => {
  const h = fixture(); t.after(() => h.harness.dispose());
  const store = h.bb.storage.kv;
  let fail = true;
  const write = store.set.bind(store);
  const crashStore = { ...store, get: store.get.bind(store), list: store.list.bind(store), delete: store.delete.bind(store), set: async (key: string, value: unknown) => {
    if (fail && key === `${LEGACY_USAGE_PREFIX}backfilled`) { fail = false; throw new Error("simulated process exit before checkpoint"); }
    await write(key, value);
  } };
  const legacy = page([{ key: "continuation.sentCounts", value: { thread: 17 } }, { key: "usage.detector.backfilled", value: "2026-10-01" }]);
  const cursors: Array<string | null> = [];
  const options = { store: crashStore, settings: h.settings, readPage: async (cursor: string | null) => { cursors.push(cursor); return legacy; } };
  await assert.rejects(migrateHeadquarters(options), /simulated process exit/);
  assert.equal(await store.get(MIGRATION_KEY), undefined);
  assert.deepEqual(await store.get(LEGACY_SENT_KEY), { thread: 17 });
  assert.equal(await migrateHeadquarters(options), true);
  assert.deepEqual(cursors, [null, null]);
  assert.deepEqual(await store.get(LEGACY_SENT_KEY), { thread: 17 });
  assert.deepEqual(await store.get(MIGRATION_KEY), { cursor: null, complete: true });
});

test("completed pages survive retry and explicit Nudger values win over legacy settings and records", async t => {
  const h = fixture({ detector: "none", typesafeApiKey: "operator-key" }); t.after(() => h.harness.dispose());
  await h.bb.storage.kv.set("recovery.paused", false);
  let fail = true;
  const calls: Array<string | null> = [];
  const options = { store: h.bb.storage.kv, settings: h.settings, readPage: async (cursor: string | null) => {
    calls.push(cursor);
    if (cursor === null) return page([{ key: "recovery.paused", value: true }], "page-2");
    if (fail) { fail = false; throw new Error("temporary HQ restart"); }
    return page([{ key: "continuation.sentCounts", value: { thread: 3 } }]);
  } };
  await assert.rejects(migrateHeadquarters(options), /temporary HQ restart/);
  assert.deepEqual(await h.bb.storage.kv.get(MIGRATION_KEY), { cursor: "page-2", complete: false });
  await migrateHeadquarters(options);
  assert.deepEqual(calls, [null, "page-2", "page-2"]);
  assert.equal(await h.bb.storage.kv.get("recovery.paused"), false);
  assert.deepEqual(await h.settings.get(), { detector: "none", typesafeApiKey: "operator-key" });
});

test("the public export schema refuses unrelated keys and a non-advancing page cannot complete migration", async t => {
  assert.equal(migrationSchema.safeParse(page([{ key: "bots.secret", value: "not recovery state" }])).success, false);
  const h = fixture(); t.after(() => h.harness.dispose());
  await assert.rejects(migrateHeadquarters({ store: h.bb.storage.kv, settings: h.settings, readPage: async () => page([], "stuck") }), /cursor did not advance/);
  assert.deepEqual(await h.bb.storage.kv.get(MIGRATION_KEY), { cursor: "stuck", complete: false });
});

test("late migration combines legacy and new counters once, even after default initialization and another reload", async t => {
  const h = fixture({ detector: "none" }); t.after(() => h.harness.dispose());
  await h.bb.storage.kv.set("continuation.sentCounts", { thread: 3 });
  const before = createContinuation({ bb: h.bb, cursor: () => null });
  await before.start(); await before.setEnabled("thread", true); await before.dispose();
  const oldLedger = createUsageLedger({ store: h.bb.storage.kv, warn: message => { throw new Error(message); }, now: () => Date.UTC(2026, 9, 1) });
  oldLedger.record("jev", null); await oldLedger.flush(); await oldLedger.backfill([]);
  const legacy = page([
    { key: "continuation.sentCounts", value: { thread: 17 } },
    { key: "continuation.off.thread", value: true },
    { key: "usage.detector.jev.2026-10-01", value: { requests: 23, errors: 2, inputTokens: 400, outputTokens: 20 } },
    { key: "usage.detector.backfilled", value: "2026-09-01" },
  ]);
  await migrateHeadquarters({ store: h.bb.storage.kv, settings: h.settings, readPage: async () => legacy });
  const cursor = { runId: "run", messageId: "message", messageRevision: 1, knownStop: false, waitingOn: null };
  const continuation = createContinuation({ bb: h.bb, cursor: () => cursor }); t.after(() => continuation.dispose());
  await continuation.start(); assert.equal(continuation.sentCount("thread"), 20);
  assert.equal(continuation.enabled("thread"), true);
  const record: RecoveryRecord = { id: "record", threadId: "thread", projectId: "project", runId: "run", messageId: "message", messageRevision: 1, observedAt: Date.now(), classification: "continue", action: "nudged", reason: "Fixture decision", detector: "fixture", judgment: null };
  const nudge = await continuation.schedule(record);
  assert.equal(continuation.decide(makeMessageDispatchHookContext({ thread: { id: "thread", status: "idle" }, experimental_submission: { pluginId: h.bb.pluginId, data: { continuationNudge: nudge.nudgeId } } }))?.action, "proceed");
  await continuation.flush(); assert.equal(continuation.sentCount("thread"), 21);
  await continuation.dispose();
  const replacement = createContinuation({ bb: h.bb, cursor: () => cursor }); t.after(() => replacement.dispose());
  await replacement.start(); assert.equal(replacement.sentCount("thread"), 21);
  assert.equal(replacement.enabled("thread"), true);
  const ledger = createUsageLedger({ store: h.bb.storage.kv, warn: message => { throw new Error(message); }, now: () => Date.UTC(2026, 9, 1) });
  assert.deepEqual((await ledger.history("jev"))?.days["2026-10-01"], { requests: 24, errors: 3, inputTokens: 400, outputTokens: 20 });
  assert.equal((await ledger.history("jev"))?.since, "2026-09-01");
  ledger.record("jev", null); await ledger.flush();
  assert.equal((await ledger.history("jev"))?.days["2026-10-01"]?.requests, 25);
  const reloaded = createUsageLedger({ store: h.bb.storage.kv, warn: message => { throw new Error(message); } });
  assert.equal((await reloaded.history("jev"))?.days["2026-10-01"]?.requests, 25);
  assert.equal(await migrateHeadquarters({ store: h.bb.storage.kv, settings: h.settings, readPage: async () => legacy }), false);
});

test("operator writes during migration's settings read and activation marker never get replaced", async t => {
  for (const gate of ["settings", "marker"] as const) {
    const h = fixture(); t.after(() => h.harness.dispose());
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const get = h.settings.get.bind(h.settings);
    const set = h.bb.storage.kv.set.bind(h.bb.storage.kv);
    if (gate === "settings") h.settings.get = async () => {
      const captured = await get(); entered.resolve(); await release.promise; return captured;
    };
    else h.bb.storage.kv.set = async (key, value) => {
      if (key === LEGACY_ACTIVATION_KEY) { entered.resolve(); await release.promise; }
      return set(key, value);
    };
    const importing = migrateHeadquarters({ store: h.bb.storage.kv, settings: h.settings, readPage: async () => page([]) });
    await entered.promise;
    await h.harness.setSettings({ detector: "none", typesafeApiKey: "new-operator-secret" });
    release.resolve(); await importing;
    assert.deepEqual(await get(), { detector: "none", typesafeApiKey: "new-operator-secret" });
    for (const key of await h.bb.storage.kv.list()) {
      const json = JSON.stringify(await h.bb.storage.kv.get(key));
      assert.equal(json.includes("new-operator-secret"), false); assert.equal(json.includes("fixture-secret"), false);
    }
  }
});

test("concurrent own preference and record writes shadow immutable copies even if the import's KV await is already open", async t => {
  const h = fixture(); t.after(() => h.harness.dispose());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const set = h.bb.storage.kv.set.bind(h.bb.storage.kv);
  h.bb.storage.kv.set = async (key, value) => {
    if (key === `${LEGACY_DATA_PREFIX}recovery.paused`) { entered.resolve(); await release.promise; }
    return set(key, value);
  };
  const importing = migrateHeadquarters({ store: h.bb.storage.kv, settings: h.settings, readPage: async () => page([
    { key: "recovery.paused", value: false }, { key: "continuation.off.thread", value: false },
    { key: "recovery.records.same", value: { reason: "Legacy record" } },
  ]) });
  await entered.promise;
  await set("recovery.paused", true);
  await set("continuation.off.thread", true);
  await set("recovery.records.same", { reason: "Own record" });
  release.resolve(); await importing;
  assert.equal(await retainedValue(h.bb.storage.kv, "recovery.paused"), true);
  assert.equal(await retainedValue(h.bb.storage.kv, "continuation.off.thread"), true);
  assert.deepEqual(await retainedValue(h.bb.storage.kv, "recovery.records.same"), { reason: "Own record" });
  assert.equal(await h.bb.storage.kv.get(`${LEGACY_DATA_PREFIX}recovery.paused`), false);
  assert.deepEqual(await h.bb.storage.kv.get(`${LEGACY_DATA_PREFIX}recovery.records.same`), { reason: "Legacy record" });
});
