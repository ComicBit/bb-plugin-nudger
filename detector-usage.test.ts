import assert from "node:assert/strict";
import { test } from "node:test";
import { createUsageLedger, meteredDetector, USAGE_FLUSH_MS, type UsageStore } from "./detector-usage.js";
import type { FinalMessageClassifier, FinalMessageJudgment, RecoveryRecord } from "./recovery-contract.js";

function memoryStore(failSets = false) {
  const values = new Map<string, unknown>();
  const writes = { count: 0 };
  const store: UsageStore = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set: async (key, value) => { writes.count++; if (failSets) throw new Error("kv offline"); values.set(key, structuredClone(value)); },
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
  return { values, store, writes };
}
function judgment(inputTokens: number | null, outputTokens: number | null = 0): FinalMessageJudgment {
  return { classification: "finished", model: "jev-1.13.0", latencyMs: 1, usage: { inputTokens, outputTokens, cost: null }, confidence: 0.9, probabilities: null, questions: null };
}
function record(id: string, observedAt: number, overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return { id, threadId: "thr", projectId: "proj", runId: id, messageId: "msg", messageRevision: 1, observedAt, classification: "finished", action: "finished", reason: "", detector: "typesafe-jev-1.13.0", judgment: judgment(100, 5), ...overrides };
}

test("every call is counted: successes add reported tokens, failures add an error", async () => {
  const { values, store, writes } = memoryStore();
  let now = Date.parse("2026-10-08T12:00:00Z");
  const ledger = createUsageLedger({ store, warn: () => assert.fail("no warning expected"), now: () => now });
  let fail = false;
  const inner: FinalMessageClassifier = { id: "typesafe-jev-1.13.0", async classify() { if (fail) throw new Error("HTTP 502"); return judgment(1_000, 40); } };
  const detector = meteredDetector(inner, "jev", ledger);
  assert.equal(detector.id, inner.id);
  await detector.classify("done");
  await detector.classify("done");
  fail = true;
  await assert.rejects(detector.classify("done"), /HTTP 502/);
  now += 1;
  // Unwritten calls already show in the history.
  assert.deepEqual((await ledger.history("jev"))?.days, { "2026-10-08": { requests: 3, errors: 1, inputTokens: 2_000, outputTokens: 80 } });
  assert.equal(writes.count, 0);
  await ledger.flush();
  assert.equal(writes.count, 1);
  assert.deepEqual(values.get("usage.detector.jev.2026-10-08"), { requests: 3, errors: 1, inputTokens: 2_000, outputTokens: 80 });
  assert.deepEqual((await ledger.history("jev"))?.days, { "2026-10-08": { requests: 3, errors: 1, inputTokens: 2_000, outputTokens: 80 } });
});

test("calls are written once per day bucket when the window ends, and a flush with nothing counted writes nothing", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { values, store, writes } = memoryStore();
  const ledger = createUsageLedger({ store, warn: () => assert.fail("no warning expected"), now: () => Date.parse("2026-10-08T12:00:00Z") });
  for (let call = 0; call < 5; call++) ledger.record("jev", judgment(10, 1));
  t.mock.timers.tick(USAGE_FLUSH_MS - 1);
  assert.equal(writes.count, 0);
  t.mock.timers.tick(1);
  await ledger.flush();
  assert.equal(writes.count, 1);
  assert.deepEqual(values.get("usage.detector.jev.2026-10-08"), { requests: 5, errors: 0, inputTokens: 50, outputTokens: 5 });
});

test("shutdown's flush stores every counted call, including ones counted while a flush runs; a restarted ledger reads them", async () => {
  const { store } = memoryStore();
  const now = () => Date.parse("2026-10-08T12:00:00Z");
  const ledger = createUsageLedger({ store, warn: () => assert.fail("no warning expected"), now });
  ledger.record("jev", judgment(10));
  const first = ledger.flush();
  ledger.record("jev", judgment(20));
  assert.equal((await ledger.history("jev"))?.days["2026-10-08"]?.requests, 2);
  await first;
  await ledger.flush();
  const restarted = createUsageLedger({ store, warn: () => assert.fail("no warning expected"), now });
  assert.deepEqual((await restarted.history("jev"))?.days, { "2026-10-08": { requests: 2, errors: 0, inputTokens: 30, outputTokens: 0 } });
});

test("calls bucket by UTC day across midnight", async () => {
  const { store } = memoryStore();
  let now = Date.parse("2026-10-07T23:59:59.999Z");
  const ledger = createUsageLedger({ store, warn: () => undefined, now: () => now });
  const detector = meteredDetector({ id: "typesafe-jev-1.13.0", classify: async () => judgment(10) }, "jev", ledger);
  await detector.classify("x");
  now = Date.parse("2026-10-08T00:00:00.000Z");
  await detector.classify("x");
  const days = (await ledger.history("jev"))!.days;
  assert.equal(days["2026-10-07"]?.requests, 1);
  assert.equal(days["2026-10-08"]?.requests, 1);
});

test("a failing store warns but never delays or fails classification", async () => {
  const { store } = memoryStore(true);
  const warnings: string[] = [];
  const ledger = createUsageLedger({ store, warn: message => warnings.push(message) });
  const detector = meteredDetector({ id: "typesafe-jev-1.13.0", classify: async () => judgment(10) }, "jev", ledger);
  assert.equal((await detector.classify("x")).classification, "finished");
  await ledger.flush();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /kv offline/);
});

test("backfill imports retained Jev classifications once, ignores removed detectors' history and marks the earliest day", async () => {
  const { values, store } = memoryStore();
  const ledger = createUsageLedger({ store, warn: () => undefined, now: () => Date.parse("2026-10-08T00:00:00Z") });
  const records = [
    record("a", Date.parse("2026-10-03T10:00:00Z")),
    record("b", Date.parse("2026-10-03T22:00:00Z"), { judgment: judgment(null, null) }),
    record("c", Date.parse("2026-10-05T01:00:00Z"), { action: "error", classification: null, judgment: null }),
    record("d", Date.parse("2026-10-01T09:00:00Z"), { action: "suppressed", classification: null, judgment: null }),
    record("e", Date.parse("2026-10-02T09:00:00Z"), { detector: "cassidy-codex-gpt-6-luna-medium-fast" }),
    record("f", Date.parse("2026-09-30T09:00:00Z"), { detector: null, judgment: null, action: "suppressed" }),
  ];
  await ledger.backfill(records);
  assert.deepEqual(await ledger.history("jev"), { since: "2026-10-03", days: {
    "2026-10-03": { requests: 2, errors: 0, inputTokens: 100, outputTokens: 5 },
    "2026-10-05": { requests: 1, errors: 1, inputTokens: 0, outputTokens: 0 },
  } });
  const before = structuredClone([...values]);
  await ledger.backfill(records);
  await createUsageLedger({ store, warn: () => undefined }).backfill(records);
  assert.deepEqual([...values], before);
});

test("backfill never double counts a ledger that already has live buckets", async () => {
  const { values, store } = memoryStore();
  values.set("usage.detector.jev.2026-10-06", { requests: 4, errors: 0, inputTokens: 400, outputTokens: 0 });
  const ledger = createUsageLedger({ store, warn: () => undefined });
  await ledger.backfill([record("a", Date.parse("2026-10-03T10:00:00Z"))]);
  assert.deepEqual(await ledger.history("jev"), { since: "2026-10-06", days: { "2026-10-06": { requests: 4, errors: 0, inputTokens: 400, outputTokens: 0 } } });
});

test("an empty history marks the ledger as starting today", async () => {
  const { store } = memoryStore();
  const ledger = createUsageLedger({ store, warn: () => undefined, now: () => Date.parse("2026-10-08T05:00:00Z") });
  await ledger.backfill([]);
  assert.deepEqual(await ledger.history("jev"), { since: "2026-10-08", days: {} });
});
