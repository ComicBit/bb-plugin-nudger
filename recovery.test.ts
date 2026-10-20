import assert from "node:assert/strict";
import { test } from "node:test";
import { RECOVERY_NUDGE, type FinalMessageClassifier, type FinalMessageJudgment, type RecoveryBlocker, type RecoveryRecord, type RecoveryService, type ThreadEventRow } from "./recovery-contract.js";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createRecoveryService } from "./recovery.js";
import { DECISION_LIMITS, GATE, historyRecordIds, OUTCOME_WINDOW_MS } from "./decision-log.js";
import { CHECK_IN_MS, createContinuation, NUDGE_STREAK_LIMIT, SCHEDULED_REASON, type Continuation } from "./continuation.js";
import { CANCEL_REASON, HELD_REASON, WITHHELD_REASON } from "./continuation-copy.js";
import { SETTLE_MS } from "./running-work.js";

const emptyControls = async (): Promise<string[]> => [];
function turn(threadId: string, runId: string, seq: number, completed = false): ThreadEventRow {
  return completed
    ? { id: `event-${seq}`, threadId, seq, createdAt: seq, scope: { kind: "turn", turnId: runId }, type: "turn/completed", data: { providerThreadId: "provider-thread", status: "completed" } }
    : { id: `event-${seq}`, threadId, seq, createdAt: seq, scope: { kind: "turn", turnId: runId }, type: "turn/started", data: { providerThreadId: "provider-thread" } };
}
function message(threadId: string, runId: string, seq: number, text = "Current work remains unfinished."): ThreadEventRow {
  return { id: `event-${seq}`, threadId, seq, createdAt: seq, scope: { kind: "turn", turnId: runId }, type: "item/completed", data: { providerThreadId: "provider-thread", item: { id: `message-${seq}`, type: "agentMessage", text } } };
}
function stop(threadId: string, seq: number): ThreadEventRow {
  return { id: `stop-${seq}`, seq, createdAt: seq, threadId, scope: { kind: "thread" }, type: "system/thread/interrupted", data: { reason: "manual-stop" } };
}
/** A `/compact` command as the auto-compact plugin sends it: the command is a mention, not just text. */
function compactRequest(threadId: string, seq: number, requestId = `creq-${seq}`): ThreadEventRow {
  return { id: `event-${seq}`, threadId, seq, createdAt: seq, scope: { kind: "thread" }, type: "client/turn/requested", data: {
    direction: "outbound", initiator: "user", source: "tell", requestId, senderThreadId: null, target: { kind: "new-turn" },
    request: { method: "turn/start", params: {} },
    execution: { model: "fixture", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/requested" },
    input: [{ type: "text", text: "/compact", mentions: [{ start: 0, end: 8,
      resource: { kind: "command", trigger: "/", name: "compact", label: "compact", source: "command", origin: "builtin", argumentHint: null } }] }] } };
}
function accepted(threadId: string, turnId: string, seq: number, clientRequestId: string): ThreadEventRow {
  return { id: `event-${seq}`, threadId, seq, createdAt: seq, scope: { kind: "turn", turnId }, type: "turn/input/accepted", data: { providerThreadId: "provider-thread", clientRequestId } };
}
function compacted(threadId: string, turnId: string, seq: number): ThreadEventRow {
  return { id: `event-${seq}`, threadId, seq, createdAt: seq, scope: { kind: "turn", turnId }, type: "thread/compacted", data: { providerThreadId: "provider-thread" } };
}
function judgment(classification: FinalMessageJudgment["classification"]): FinalMessageJudgment {
  return { classification, model: "fixture-no-model-call", latencyMs: 0, usage: { inputTokens: null, outputTokens: null, cost: null }, confidence: 1, probabilities: null, questions: null };
}
function deferred<T>() {
  return Promise.withResolvers<T>();
}
function fixture(count = 1, classify: FinalMessageClassifier["classify"] = async () => judgment("continue"), withContinuation = false) {
  const threads = Array.from({ length: count }, (_, index) => ({ ...makeThreadResponse({ id: `thread-${index}`, projectId: "project", status: "active" }), environmentHostId: "host" }));
  const history = new Map(threads.map(thread => [thread.id, [turn(thread.id, `run-${thread.id}`, 1)]]));
  const metadata = new Map<string, { role?: string }>();
  const reads: Array<{ threadId: string; afterSeq?: string; limit?: string }> = [];
  const offsets: number[] = [];
  const classified: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const reports: RecoveryBlocker[] = [];
  const waiters = new Set<() => void>();
  const controls: {
    list?: (offset: number, limit: number) => Promise<typeof threads>;
    beforeRead?: (threadId: string) => Promise<void>;
    readComplete?: (threadId: string) => void;
  } = {};
  let sends = 0;
  const { bb, harness } = createFakePluginHost({ sdk: {
    projects: { list: async () => [{ id: "project", name: "Fixture" }] },
    threads: {
      list: async ({ offset = 0, limit = 100 } = {}) => { offsets.push(offset); return controls.list ? controls.list(offset, limit) : threads.slice(offset, offset + limit); },
      get: async ({ threadId }) => { const thread = threads.find(row => row.id === threadId); if (!thread) throw new Error("Unknown fixture thread"); return thread; },
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
      events: { list: async args => {
        reads.push(args);
        await controls.beforeRead?.(args.threadId);
        if (Number(args.limit ?? 100) > 100) throw new Error("Thread event limit cannot exceed 100");
        const rows = (history.get(args.threadId) ?? []).filter(row => row.seq > Number(args.afterSeq ?? -1) && row.seq < Number(args.beforeSeq ?? Infinity) && (!args.types || args.types.includes(row.type)));
        const result = (args.order === "desc" ? [...rows].reverse() : rows).slice(0, Number(args.limit ?? 100));
        controls.readComplete?.(args.threadId);
        return result;
      } },
      send: async args => {
        sends++;
        if (!continuation) throw new Error("No dispatch permitted");
        continuationSends.push({ ...args });
        return { ok: true as const, delivery: "queued" as const, queuedMessage: makeQueueEntry({ id: `queued-${sends}`, threadId: args.threadId, sendAt: args.sendAt ?? null, waitingOn: { kind: "time" } }) };
      },
      queuedMessages: { delete: async () => ({ ok: true as const }) },
    },
  } });
  let service: RecoveryService;
  const continuationSends: Array<Record<string, unknown>> = [];
  const continuation: Continuation | null = withContinuation ? createContinuation({ bb, cursor: threadId => service.cursor(threadId), onChange: threadId => service.noteNudge(threadId) }) : null;
  service = createRecoveryService({ bb, controlThreadIds: emptyControls,
    detector: { id: "fixture", classify: async (text, options) => { classified.push(text); signals.push(options?.signal); return classify(text, options); } },
    reportBlocker: async blocker => { reports.push(blocker); },
    onChange: () => { for (const waiter of waiters) waiter(); },
    ...(continuation ? { continuation } : {}),
  });
  /** Resolves once `ready` holds, re-checked on every recovery change. */
  function until(ready: () => boolean): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => { if (ready()) { waiters.delete(check); resolve(); } };
    waiters.add(check); check();
    return promise;
  }
  async function waitForRecord(threadId: string, action: RecoveryRecord["action"]): Promise<RecoveryRecord> {
    const find = () => service.records().find(row => row.threadId === threadId && row.action === action);
    await until(() => find() !== undefined);
    return find()!;
  }
  async function finish(index = 0, text?: string) {
    const thread = threads[index]!;
    const runId = `run-${thread.id}`;
    const seq = Math.max(0, ...(history.get(thread.id) ?? []).map(row => row.seq));
    history.get(thread.id)!.push(message(thread.id, runId, seq + 1, text), turn(thread.id, runId, seq + 2, true));
    thread.status = "idle";
    await harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Not an authoritative final item" });
  }
  return { bb, service, harness, threads, history, metadata, reads, offsets, classified, signals, reports, controls, finish, until, waitForRecord, continuation, continuationSends, counts: () => ({ classifications: classified.length, sends }) };
}

test("stock inventory enumerates every page and excludes hidden, child, own-origin and own-role threads", async t => {
  const h = fixture(205); t.after(() => h.service.dispose());
  h.threads[0]!.visibility = "hidden";
  h.threads[1]!.parentThreadId = "parent";
  h.threads[2]!.originPluginId = "test-plugin";
  h.metadata.set("thread-3", { role: "control" });
  await h.service.start();
  assert.deepEqual(h.offsets, [0, 100, 200]);
  assert.equal(h.service.status().threads.length, 205);
  assert.equal(h.service.status().watchedCount, 201);
  assert.deepEqual(h.service.status().threads.slice(0, 4).map(thread => thread.exclusion), ["hidden", "child", "orchestrator identity", "own control role"]);
  assert.ok(h.reads.every(read => !["thread-0", "thread-1", "thread-2", "thread-3"].includes(read.threadId)));
  for (let index = 0; index < 4; index++) await h.finish(index);
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
});

test("startup baselines idle history without replay and classifies only live root endings once", async t => {
  const h = fixture(2); t.after(() => h.service.dispose());
  const idle = h.threads[0]!;
  idle.status = "idle";
  h.history.get(idle.id)!.push(message(idle.id, `run-${idle.id}`, 2), turn(idle.id, `run-${idle.id}`, 3, true));
  await h.service.start();
  assert.equal(h.service.records().length, 0);
  assert.equal(h.reads.find(read => read.threadId === idle.id)?.limit, "1");
  await h.finish(1);
  await h.waitForRecord(h.threads[1]!.id, "suppressed");
  await h.service.refresh();
  await h.harness.emitThreadEvent("experimental_thread.events", { thread: h.threads[1]!, sequence: 3 });
  const records = h.service.records();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.messageId, "message-2");
  assert.equal(records[0]!.classification, "continue");
  assert.match(records[0]!.reason, /auto-continue is off/);
  assert.deepEqual(h.classified, ["Current work remains unfinished."]);
  assert.deepEqual(h.counts(), { classifications: 1, sends: 0 });
});

test("a previously idle chat activated after startup is observed and its ending is classified once", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const thread = h.threads[0]!;
  thread.status = "idle";
  h.history.set(thread.id, []);
  await h.service.start();
  assert.equal(h.service.status().watchedCount, 0);
  thread.status = "active";
  h.history.get(thread.id)!.push(turn(thread.id, `run-${thread.id}`, 1));
  await h.harness.emitThreadEvent("thread.active", { thread });
  assert.equal(h.service.status().watchedCount, 1);
  await h.finish();
  await h.waitForRecord(thread.id, "suppressed");
  await h.service.refresh();
  assert.equal(h.service.records().length, 1);
  assert.deepEqual(h.counts(), { classifications: 1, sends: 0 });
});

test("activation reconstructs a live root whose start was already below an idle baseline cursor", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const thread = h.threads[0]!;
  thread.status = "starting";
  await h.service.start();
  assert.equal(h.service.status().watchedCount, 0);
  thread.status = "active";
  await h.harness.emitThreadEvent("thread.active", { thread });
  assert.equal(h.service.status().watchedCount, 1);
  await h.finish(); await h.waitForRecord(thread.id, "suppressed");
  assert.deepEqual(h.counts(), { classifications: 1, sends: 0 });
});

test("canonical active and runtime active both trigger root-backed baseline observation", async t => {
  const h = fixture(2); t.after(() => h.service.dispose());
  h.threads[0]!.runtime.displayStatus = "idle";
  h.threads[1]!.status = "idle"; h.threads[1]!.runtime.displayStatus = "active";
  await h.service.start();
  assert.equal(h.service.status().watchedCount, 2);
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
});

test("runtime activity alone cannot classify an already completed historical root", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const thread = h.threads[0]!;
  thread.status = "idle"; thread.runtime.displayStatus = "active";
  h.history.get(thread.id)!.push(message(thread.id, `run-${thread.id}`, 2), turn(thread.id, `run-${thread.id}`, 3, true));
  await h.service.start();
  await h.service.refresh();
  assert.equal(h.service.status().watchedCount, 0);
  assert.equal(h.service.records().length, 0);
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
});

test("an eligible thread first discovered by an active event after startup becomes watched", async t => {
  const h = fixture(0); t.after(() => h.service.dispose()); await h.service.start();
  const thread = { ...makeThreadResponse({ id: "thread-later", projectId: "project", status: "active" }), environmentHostId: "host" };
  h.threads.push(thread);
  h.history.set(thread.id, [turn(thread.id, `run-${thread.id}`, 1)]);
  await h.harness.emitThreadEvent("thread.active", { thread });
  assert.equal(h.service.status().threads.length, 1);
  assert.equal(h.service.status().watchedCount, 1);
  await h.finish();
  await h.waitForRecord(thread.id, "suppressed");
  assert.deepEqual(h.counts(), { classifications: 1, sends: 0 });
});

test("coalesced lifecycle wakes read incremental root facts and ignore child-turn endings", async t => {
  const h = fixture(); t.after(() => h.service.dispose()); await h.service.start();
  const thread = h.threads[0]!;
  const child = turn(thread.id, "nested", 2);
  if (child.type === "turn/started") child.data.parentToolCallId = "tool";
  h.history.get(thread.id)!.push(child, message(thread.id, "nested", 3), turn(thread.id, "nested", 4, true), message(thread.id, `run-${thread.id}`, 5), turn(thread.id, `run-${thread.id}`, 6, true));
  thread.status = "idle";
  await h.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 6 });
  await h.waitForRecord(thread.id, "suppressed");
  assert.equal(h.service.records().length, 1);
  assert.equal(h.service.records()[0]!.messageId, "message-5");
  assert.ok(h.reads.some(read => read.afterSeq === "1"));
});

test("slow classification does not block observation or classification of another active chat", async t => {
  const slow = deferred<FinalMessageJudgment>();
  const h = fixture(2, async text => text === "Slow ending" ? slow.promise : judgment("finished"));
  t.after(() => h.service.dispose()); await h.service.start();
  await h.finish(0, "Slow ending");
  assert.deepEqual(h.classified, ["Slow ending"]);
  await h.finish(1, "Second ending");
  await h.waitForRecord(h.threads[1]!.id, "finished");
  assert.equal(h.service.records().length, 2);
  slow.resolve(judgment("continue"));
  await h.waitForRecord(h.threads[0]!.id, "suppressed");
  assert.equal(h.counts().sends, 0);
});

for (const kind of ["blocker", "permission", "uncertainty"] as const) {
  test(`a live ${kind} ending routes one final-message-only blocker without continuation admission`, async t => {
    const h = fixture(1, async () => judgment(kind)); t.after(() => h.service.dispose()); await h.service.start();
    await h.finish(0, `Final ${kind} evidence`);
    const record = await h.waitForRecord(h.threads[0]!.id, "reported");
    await h.service.refresh();
    assert.equal(record.classification, kind);
    assert.deepEqual(h.classified, [`Final ${kind} evidence`]);
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0]!.finalAssistantMessage, `Final ${kind} evidence`);
    assert.equal(h.reports[0]!.messageRevision, 2);
    assert.equal(h.counts().sends, 0);
  });
}

test("pause keeps inventory observing but suppresses classification of paused endings", async t => {
  const h = fixture(); t.after(() => h.service.dispose()); await h.service.start();
  assert.equal(h.service.status().observing, true);
  assert.equal(h.service.status().classifying, true);
  await h.service.setPaused(true);
  await h.finish();
  assert.equal(h.service.status().observing, true);
  assert.equal(h.service.status().classifying, false);
  assert.equal(h.service.records()[0]!.action, "suppressed");
  await h.service.setPaused(false);
  await h.service.refresh();
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
});

test("an ending received while paused does not replay if observation finishes after resume", async t => {
  const h = fixture(); t.after(() => h.service.dispose()); await h.service.start();
  await h.service.setPaused(true);
  const entered = deferred<void>(); const release = deferred<void>();
  h.controls.beforeRead = async () => { entered.resolve(); await release.promise; };
  const ending = h.finish();
  await entered.promise;
  await h.service.setPaused(false);
  release.resolve();
  await ending;
  h.controls.beforeRead = undefined;
  await h.service.refresh();
  assert.equal(h.service.records()[0]!.action, "suppressed");
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
});

for (const cancellation of ["pause", "stop", "dispose", "hidden", "new-run", "detector"] as const) {
  test(`${cancellation} cancels a pending classifier and prevents blocker routing`, async t => {
    const slow = deferred<FinalMessageJudgment>();
    const h = fixture(1, async () => slow.promise); t.after(() => h.service.dispose()); await h.service.start();
    await h.finish();
    const thread = h.threads[0]!;
    assert.equal(h.classified.length, 1);
    if (cancellation === "pause") { await h.service.setPaused(true); await h.service.setPaused(false); }
    if (cancellation === "dispose") await h.service.dispose();
    if (cancellation === "detector") h.service.configure(null);
    if (cancellation === "hidden") { thread.visibility = "hidden"; thread.updatedAt++; await h.service.refresh(); }
    if (cancellation === "new-run") { thread.status = "active"; h.history.get(thread.id)!.push(turn(thread.id, "later-run", 4)); await h.harness.emitThreadEvent("thread.active", { thread }); }
    if (cancellation === "stop") { h.history.get(thread.id)!.push(stop(thread.id, 4)); await h.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 4 }); }
    assert.equal(h.signals[0]?.aborted, true);
    slow.resolve(judgment("blocker"));
    await Promise.resolve();
    if (cancellation !== "dispose") await h.service.refresh();
    assert.equal(h.reports.length, 0);
    assert.equal(h.counts().sends, 0);
    assert.equal(h.service.records()[0]!.action, "suppressed");
  });
}

test("an observed Stop cannot be rearmed by active events, plugin inputs, or old queued inputs", async t => {
  const h = fixture(); t.after(() => h.service.dispose()); await h.service.start();
  const thread = h.threads[0]!;
  h.history.get(thread.id)!.push(stop(thread.id, 2), turn(thread.id, "plugin-or-queued-run", 3), message(thread.id, "plugin-or-queued-run", 4), turn(thread.id, "plugin-or-queued-run", 5, true));
  await h.harness.emitThreadEvent("thread.active", { thread });
  await h.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 5 });
  await h.service.refresh();
  assert.equal(h.service.records().length, 0);
  assert.match(h.service.status().threads[0]!.exclusion!, /Observed manual Stop/);
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
});

test("stale inventory pages cannot regress fresher lifecycle status", async t => {
  const h = fixture(); t.after(() => h.service.dispose()); await h.service.start();
  const thread = h.threads[0]!;
  thread.status = "idle"; thread.updatedAt = 20;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  h.controls.list = async () => [{ ...thread, status: "active", updatedAt: 10 }];
  await h.service.refresh();
  assert.equal(h.service.status().threads[0]!.status, "idle");
});

test("equal-timestamp stale inventory cannot override an event's committed status", async t => {
  const h = fixture(); t.after(() => h.service.dispose()); await h.service.start();
  const thread = h.threads[0]!;
  thread.status = "idle";
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  h.controls.list = async () => [{ ...thread, status: "active" }];
  await h.service.refresh();
  assert.equal(h.service.status().threads[0]!.status, "idle");
});

test("a lifecycle event received during startup is not lost to a stale startup page", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const thread = h.threads[0]!;
  thread.status = "idle"; h.history.set(thread.id, []);
  const entered = deferred<void>(); const release = deferred<void>();
  h.controls.list = async () => { entered.resolve(); await release.promise; return [{ ...thread, status: "idle", updatedAt: 0 }]; };
  const starting = h.service.start();
  await entered.promise;
  thread.status = "active"; thread.updatedAt = 1;
  h.history.get(thread.id)!.push(turn(thread.id, `run-${thread.id}`, 1));
  const event = h.harness.emitThreadEvent("thread.active", { thread });
  release.resolve();
  await starting; await event;
  assert.equal(h.service.status().threads[0]!.status, "active");
  assert.equal(h.service.status().watchedCount, 1);
  h.controls.list = undefined;
  await h.finish(); await h.waitForRecord(thread.id, "suppressed");
  assert.deepEqual(h.counts(), { classifications: 1, sends: 0 });
});

test("an execution ending during slow startup inventory retains its event-time live baseline", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const thread = h.threads[0]!;
  thread.status = "idle"; h.history.set(thread.id, []);
  const entered = deferred<void>(); const release = deferred<void>(); const captured = deferred<void>();
  h.controls.list = async () => { entered.resolve(); await release.promise; return [{ ...thread, status: "idle", updatedAt: 0 }]; };
  h.controls.readComplete = () => captured.resolve();
  const starting = h.service.start();
  await entered.promise;
  thread.status = "active"; thread.updatedAt = 1;
  h.history.get(thread.id)!.push(turn(thread.id, `run-${thread.id}`, 1));
  const active = h.harness.emitThreadEvent("thread.active", { thread });
  await captured.promise;
  h.history.get(thread.id)!.push(message(thread.id, `run-${thread.id}`, 2), turn(thread.id, `run-${thread.id}`, 3, true));
  thread.status = "idle"; thread.updatedAt = 2;
  const idle = h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Ignore assembled output" });
  release.resolve();
  await starting; await active; await idle;
  await h.waitForRecord(thread.id, "suppressed");
  assert.equal(h.service.records().length, 1);
  assert.deepEqual(h.counts(), { classifications: 1, sends: 0 });
});

test("periodic reconciliation discovers activation without a lifecycle announcement and stops on disposal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = fixture(); t.after(() => h.service.dispose());
  const thread = h.threads[0]!;
  thread.status = "idle"; h.history.set(thread.id, []);
  await h.service.start();
  thread.status = "active"; h.history.get(thread.id)!.push(turn(thread.id, `run-${thread.id}`, 1));
  t.mock.timers.tick(30_000);
  await h.service.refresh();
  assert.equal(h.service.status().watchedCount, 1);
  assert.ok(h.offsets.length >= 3);
  await h.service.dispose();
  const reads = h.offsets.length;
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(h.offsets.length, reads);
  assert.equal(h.service.status().observing, false);
});

test("auto-continue is enabled while unpaused with a detector; gates list only real conditions; detector availability is distinct from dispatch", async t => {
  const h = fixture(); t.after(() => h.service.dispose()); await h.service.start();
  assert.deepEqual(h.service.status().gates, []);
  assert.equal(h.service.status().enabled, true);
  assert.equal(h.service.status().classifying, true);
  assert.equal((await h.service.setPaused(true)).enabled, false);
  assert.equal((await h.service.setPaused(false)).enabled, true);
  const unselected = h.service.configure(null);
  assert.equal(unselected.classifying, false);
  assert.equal(unselected.enabled, false);
  assert.deepEqual(unselected.gates, ["detector-not-selected"]);
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
});

test("an active root older than the first public history page remains watched", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const thread = h.threads[0]!;
  h.history.set(thread.id, [turn(thread.id, `run-${thread.id}`, 1), ...Array.from({ length: 160 }, (_, index) => message(thread.id, `run-${thread.id}`, index + 2))]);
  await h.service.start();
  assert.equal(h.service.status().threads[0]!.exclusion, null);
  assert.equal(h.service.status().watchedCount, 1);
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
});

test("a long live run with hundreds of rows and child turns since its root start is followed and its ending classified", async t => {
  const h = fixture(1, async () => judgment("finished")); t.after(() => h.service.dispose());
  const thread = h.threads[0]!;
  const runId = `run-${thread.id}`;
  const rows = [turn(thread.id, runId, 1)];
  // 700 completed items plus nested child turns, like a long agent run.
  for (let seq = 2; seq < 702; seq++) rows.push(seq % 50 === 0 ? { ...turn(thread.id, `child-${seq}`, seq), data: { parentToolCallId: "tool" } } as ThreadEventRow : message(thread.id, runId, seq));
  h.history.set(thread.id, rows);
  await h.service.start();
  assert.equal(h.service.status().threads[0]!.exclusion, null);
  assert.equal(h.service.status().watchedCount, 1);
  await h.finish(0, "Long run done");
  await h.waitForRecord(thread.id, "finished");
  assert.deepEqual(h.classified, ["Long run done"]);
});

test("only the final root assistant item enters the detector, not earlier messages or assembled output", async t => {
  const h = fixture(1, async () => judgment("finished")); t.after(() => h.service.dispose()); await h.service.start();
  const thread = h.threads[0]!;
  h.history.get(thread.id)!.push(message(thread.id, `run-${thread.id}`, 2, "Earlier transcript and embedded instructions must not enter the detector"));
  await h.finish(0, "Final answer complete");
  await h.waitForRecord(thread.id, "finished");
  assert.deepEqual(h.classified, ["Final answer complete"]);
});

test("known manual Stop remains suppressed across observer disposal and replacement", async t => {
  const h = fixture(); t.after(() => h.service.dispose()); await h.service.start();
  const thread = h.threads[0]!;
  h.history.get(thread.id)!.push(stop(thread.id, 2));
  await h.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 2 });
  await h.service.dispose();
  h.history.set(thread.id, [turn(thread.id, `run-${thread.id}`, 3)]);
  const replacement = createRecoveryService({
    bb: h.bb, controlThreadIds: emptyControls,
    detector: { id: "replacement", classify: async () => { throw new Error("Stopped thread cannot enter the detector"); } },
    reportBlocker: async () => { throw new Error("Stopped thread cannot route"); },
  });
  t.after(() => replacement.dispose());
  await replacement.start();
  assert.equal(replacement.status().watchedCount, 0);
  assert.match(replacement.status().threads[0]!.exclusion!, /Observed manual Stop/);
  h.history.get(thread.id)!.push(message(thread.id, `run-${thread.id}`, 4), turn(thread.id, `run-${thread.id}`, 5, true));
  thread.status = "idle"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  assert.equal(replacement.records().length, 0);
});

test("admitted human input re-arms a stopped thread, survives replacement, and a later Stop applies again", async t => {
  const h = fixture(); t.after(() => h.service.dispose()); await h.service.start();
  const thread = h.threads[0]!;
  h.history.get(thread.id)!.push(stop(thread.id, 2));
  await h.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 2 });
  assert.equal(h.service.status().watchedCount, 0);
  h.service.rearm(thread.id, 10);
  await h.service.dispose();
  // A replacement observer re-reads the old Stop row from history; the persisted re-arm keeps it inert.
  h.history.get(thread.id)!.push(turn(thread.id, "fresh-run", 11));
  const classified: string[] = [];
  const replacement = createRecoveryService({ bb: h.bb, controlThreadIds: emptyControls,
    detector: { id: "replacement", classify: async text => { classified.push(text); return judgment("finished"); } },
    reportBlocker: async () => {} });
  t.after(() => replacement.dispose());
  await replacement.start();
  assert.equal(replacement.status().threads[0]!.exclusion, null);
  h.history.get(thread.id)!.push(message(thread.id, "fresh-run", 12, "Fresh ending"), turn(thread.id, "fresh-run", 13, true));
  thread.status = "idle"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await replacement.refresh();
  assert.deepEqual(classified, ["Fresh ending"]);
  h.history.get(thread.id)!.push(stop(thread.id, 14));
  await h.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 14 });
  await replacement.refresh();
  assert.match(replacement.status().threads[0]!.exclusion!, /Observed manual Stop/);
});

test("continue endings schedule one nudge per thread that is on; a thread turned off stays suppressed", async t => {
  const h = fixture(3, undefined, true); t.after(() => h.service.dispose());
  await h.continuation!.start(); await h.service.start();
  await h.continuation!.setEnabled("thread-2", false);
  await h.finish(0); await h.finish(1); await h.finish(2);
  const first = await h.waitForRecord("thread-0", "nudged");
  const second = await h.waitForRecord("thread-1", "nudged");
  const off = await h.waitForRecord("thread-2", "suppressed");
  assert.equal(first.reason, SCHEDULED_REASON);
  assert.equal(off.reason, "Continuation candidate classified, but auto-continue is off for this thread");
  // The plugin timers send only after the delay; nothing is sent at scheduling time.
  assert.equal(h.continuationSends.length, 0);
  const pending = h.continuation!.snapshot().pending;
  assert.deepEqual(pending.map(nudge => nudge.threadId).sort(), ["thread-0", "thread-1"]);
  for (const record of [first, second]) {
    const nudge = pending.find(row => row.threadId === record.threadId)!;
    assert.deepEqual([nudge.runId, nudge.messageId, nudge.messageRevision], [record.runId, record.messageId, record.messageRevision]);
    assert.deepEqual(h.service.cursor(record.threadId), { runId: record.runId, messageId: record.messageId, messageRevision: record.messageRevision, knownStop: false, waitingOn: null });
  }
  assert.equal(h.continuation!.latest("thread-2"), null);
  assert.deepEqual(h.counts(), { classifications: 3, sends: 0 });
  h.continuation!.dispose();
});

test("observed manual Stop cancels only that thread's pending nudge", async t => {
  const h = fixture(2, undefined, true); t.after(() => h.service.dispose());
  await h.continuation!.start(); await h.service.start();
  await h.finish(0); await h.finish(1);
  await h.waitForRecord("thread-0", "nudged");
  await h.waitForRecord("thread-1", "nudged");
  const thread = h.threads[0]!;
  h.history.get(thread.id)!.push(stop(thread.id, 10));
  thread.updatedAt++;
  await h.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 10 });
  assert.deepEqual(h.continuation!.snapshot().pending.map(nudge => nudge.threadId), ["thread-1"]);
  assert.deepEqual(h.continuation!.snapshot("thread-0").log.map(entry => [entry.event, entry.reason]).at(-1), ["cancelled", "manual Stop observed"]);
  h.continuation!.dispose();
});

test("an owner's ending waits while its hidden workflow step runs, then is judged once the workflow settles", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const h = fixture(2, undefined, true); t.after(() => { h.continuation!.dispose(); return h.service.dispose(); });
  const owner = h.threads[0]!, step = h.threads[1]!;
  Object.assign(step, { visibility: "hidden", originPluginId: "workflows", lifecycleOwnerThreadId: owner.id });
  await h.continuation!.start(); await h.service.start();
  // The step itself stays a hidden worker: never judged, never nudged.
  assert.equal(h.service.status().threads.find(thread => thread.id === step.id)?.exclusion, "hidden");
  assert.deepEqual(h.service.threadState(owner.id).wait, { kind: "workflow", running: 1, settlingUntil: null });
  await h.finish(0, "The fixture setup is complete; the workflow is running…");
  const held = await h.waitForRecord(owner.id, "suppressed");
  assert.equal(held.reason, HELD_REASON.workflow);
  assert.equal(h.service.cursor(owner.id)?.waitingOn, "workflow");
  // The step ends; the owner still waits through the settle window for a next step or the finishing message.
  step.status = "idle"; step.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread: step, lastAssistantText: null });
  assert.deepEqual(h.service.threadState(owner.id).wait, { kind: "workflow", running: 0, settlingUntil: 1_000 + SETTLE_MS });
  t.mock.timers.tick(SETTLE_MS - 1);
  await h.service.refresh();
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
  t.mock.timers.tick(1);
  const nudged = await h.waitForRecord(owner.id, "nudged");
  assert.equal(nudged.id, held.id);
  assert.deepEqual(h.classified, ["The fixture setup is complete; the workflow is running…"]);
  assert.equal(h.continuation!.latest(owner.id)?.state, "pending");
  assert.equal(h.service.threadState(owner.id).wait, null);
});

test("a new owner turn while its workflow runs supersedes the held ending; only the new ending is judged", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const h = fixture(2, async () => judgment("finished")); t.after(() => h.service.dispose());
  const owner = h.threads[0]!, step = h.threads[1]!;
  Object.assign(step, { visibility: "hidden", originPluginId: "workflows", lifecycleOwnerThreadId: owner.id });
  await h.service.start();
  await h.finish(0, "Workflow started");
  await h.waitForRecord(owner.id, "suppressed");
  // The workflow's finishing message starts a new owner turn, and its step is done.
  owner.status = "active"; owner.updatedAt++;
  h.history.get(owner.id)!.push(turn(owner.id, "run-finishing", 10));
  await h.harness.emitThreadEvent("thread.active", { thread: owner });
  assert.equal(h.service.records()[0]!.reason, "A later root execution superseded the classified ending");
  step.status = "idle"; step.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread: step, lastAssistantText: null });
  t.mock.timers.tick(SETTLE_MS);
  await h.service.refresh();
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
  h.history.get(owner.id)!.push(message(owner.id, "run-finishing", 11, "All four steps passed."), turn(owner.id, "run-finishing", 12, true));
  owner.status = "idle"; owner.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread: owner, lastAssistantText: null });
  await h.waitForRecord(owner.id, "finished");
  assert.deepEqual(h.classified, ["All four steps passed."]);
  assert.equal(h.service.records()[0]!.action, "suppressed");
});

test("a step starting during the countdown withholds the nudge; the unchanged ending reuses its judgment after the workflow settles", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const h = fixture(2, undefined, true); t.after(() => { h.continuation!.dispose(); return h.service.dispose(); });
  const owner = h.threads[0]!, step = h.threads[1]!;
  Object.assign(step, { visibility: "hidden", originPluginId: "workflows", lifecycleOwnerThreadId: owner.id, status: "idle" });
  await h.continuation!.start(); await h.service.start();
  await h.finish(0, "Kicked off the workflow.");
  await h.waitForRecord(owner.id, "nudged");
  const nudge = h.continuation!.latest(owner.id)!;
  assert.equal(nudge.state, "pending");
  step.status = "active"; step.updatedAt++;
  await h.harness.emitThreadEvent("thread.active", { thread: step });
  assert.equal(h.service.cursor(owner.id)?.waitingOn, "workflow");
  // Core runs the dispatch hook when the countdown sends.
  const decision = h.continuation!.decide(makeMessageDispatchHookContext({ thread: { id: owner.id, status: "idle" }, initiator: "system", input: { text: RECOVERY_NUDGE },
    experimental_submission: { pluginId: h.bb.pluginId, data: { continuationNudge: nudge.nudgeId } } }));
  assert.deepEqual(decision, { action: "reject", message: "Nudger didn't send its nudge: its workflow was running." });
  const withheld = h.continuation!.latest(owner.id)!;
  assert.deepEqual([withheld.state, withheld.cancelReason], ["withheld", WITHHELD_REASON.workflow]);
  step.status = "idle"; step.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread: step, lastAssistantText: null });
  t.mock.timers.tick(SETTLE_MS);
  await h.service.refresh();
  await h.waitForRecord(owner.id, "nudged");
  const again = h.continuation!.latest(owner.id)!;
  assert.notEqual(again.nudgeId, nudge.nudgeId);
  assert.deepEqual([again.state, again.messageId], ["pending", nudge.messageId]);
  assert.deepEqual(h.counts(), { classifications: 1, sends: 0 });
});

test("a parent's ending is not judged while its subthread runs; the subthread's report starts the run that is", async t => {
  const h = fixture(2, async () => judgment("finished"), true); t.after(() => { h.continuation!.dispose(); return h.service.dispose(); });
  const parent = h.threads[0]!, child = h.threads[1]!;
  child.parentThreadId = parent.id;
  await h.continuation!.start(); await h.service.start();
  // The subthread itself is never judged.
  assert.equal(h.service.status().threads.find(thread => thread.id === child.id)?.exclusion, "child");
  assert.deepEqual(h.service.threadState(parent.id).wait, { kind: "subthread", running: 1, settlingUntil: null });
  await h.finish(0, "Spawned a subthread for the migration; waiting for its report.");
  const held = await h.waitForRecord(parent.id, "suppressed");
  assert.deepEqual([held.reason, h.service.threadState(parent.id).latestRecord?.gate], [HELD_REASON.subthread, GATE.subthread]);
  assert.equal(h.service.cursor(parent.id)?.waitingOn, "subthread");
  // The subthread finishes and its report reaches the parent, which carries on.
  child.status = "idle"; child.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread: child, lastAssistantText: null });
  parent.status = "active"; parent.updatedAt++;
  h.history.get(parent.id)!.push(turn(parent.id, "run-report", 10));
  await h.harness.emitThreadEvent("thread.active", { thread: parent });
  // The report run supersedes the held ending and ends the wait: its own ending stands on its own.
  assert.equal(h.service.threadState(parent.id).latestRecord?.gate, GATE.superseded);
  assert.equal(h.service.threadState(parent.id).wait, null);
  h.history.get(parent.id)!.push(message(parent.id, "run-report", 11, "Migration merged; all done."), turn(parent.id, "run-report", 12, true));
  parent.status = "idle"; parent.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread: parent, lastAssistantText: null });
  await h.waitForRecord(parent.id, "finished");
  assert.deepEqual(h.classified, ["Migration merged; all done."]);
  assert.equal(h.continuation!.latest(parent.id), null);
});

test("a running nested subthread holds the root while its own parent idles; a root nobody reports back to is judged after the settle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const h = fixture(3, undefined, true); t.after(() => { h.continuation!.dispose(); return h.service.dispose(); });
  const root = h.threads[0]!, child = h.threads[1]!, grandchild = h.threads[2]!;
  Object.assign(child, { parentThreadId: root.id, status: "idle" });
  grandchild.parentThreadId = child.id;
  await h.continuation!.start(); await h.service.start();
  await h.finish(0, "Delegated the audit; its subthreads are working.");
  const held = await h.waitForRecord(root.id, "suppressed");
  assert.equal(held.reason, HELD_REASON.subthread);
  grandchild.status = "idle"; grandchild.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread: grandchild, lastAssistantText: null });
  assert.deepEqual(h.service.threadState(root.id).wait, { kind: "subthread", running: 0, settlingUntil: 1_000 + SETTLE_MS });
  t.mock.timers.tick(SETTLE_MS - 1);
  await h.service.refresh();
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
  // No report arrived (parent notifications off, say): the unchanged ending is judged once.
  t.mock.timers.tick(1);
  const nudged = await h.waitForRecord(root.id, "nudged");
  assert.equal(nudged.id, held.id);
  assert.deepEqual(h.classified, ["Delegated the audit; its subthreads are working."]);
  assert.equal(h.service.threadState(root.id).wait, null);
});

test("the /compact turn that followed Task A's ending never replaces it: the real reply is judged once, after the compaction", async t => {
  const h = fixture(1, undefined, true); t.after(() => { h.continuation!.dispose(); return h.service.dispose(); });
  const thread = h.threads[0]!, runId = `run-${thread.id}`;
  await h.continuation!.start(); await h.service.start();
  // The ending, then auto-compact's /compact as its own root turn, all in one read.
  h.history.get(thread.id)!.push(
    message(thread.id, runId, 349, "The fixture setup is complete; the workflow is running…"),
    turn(thread.id, runId, 36820, true),
    compactRequest(thread.id, 36821, "creq_compact"),
    turn(thread.id, "t3", 36822),
    { id: "event-36823", threadId: thread.id, seq: 36823, createdAt: 36823, scope: { kind: "turn", turnId: "t3" }, type: "item/started",
      data: { providerThreadId: "provider-thread", item: { id: "compaction", type: "contextCompaction" } } },
    accepted(thread.id, "t3", 36824, "creq_compact"),
    message(thread.id, "t3", 36827, "Compaction complete. Tokens: 200000 -> 10000 (saved 190000)."),
    compacted(thread.id, "t3", 36828),
    turn(thread.id, "t3", 36829, true));
  thread.status = "idle";
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Compaction complete. Tokens: 200000 -> 10000 (saved 190000)." });
  const record = await h.waitForRecord(thread.id, "nudged");
  assert.deepEqual([record.runId, record.messageId, record.classification], [runId, "message-349", "continue"]);
  assert.deepEqual(h.classified, ["The fixture setup is complete; the workflow is running…"]);
  assert.deepEqual(h.service.cursor(thread.id), { runId, messageId: "message-349", messageRevision: 349, knownStop: false, waitingOn: null });
  assert.equal(h.service.threadState(thread.id).compacting, false);
  assert.deepEqual(h.continuation!.snapshot(thread.id).pending.map(nudge => nudge.messageId), ["message-349"]);
  assert.equal(h.service.records().length, 1);
});

test("a /compact turn cancels the pending nudge, then renews it without reclassifying the unchanged reply", async t => {
  const h = fixture(1, undefined, true); t.after(() => { h.continuation!.dispose(); return h.service.dispose(); });
  const thread = h.threads[0]!;
  await h.continuation!.start(); await h.service.start();
  await h.finish(0, "Reply before compaction");
  await h.waitForRecord(thread.id, "nudged");
  const first = h.continuation!.latest(thread.id)!;
  h.history.get(thread.id)!.push(compactRequest(thread.id, 10), turn(thread.id, "compaction", 11), accepted(thread.id, "compaction", 12, "creq-10"));
  thread.status = "active"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.active", { thread });
  assert.deepEqual([h.continuation!.latest(thread.id)?.state, h.continuation!.latest(thread.id)?.cancelReason], ["cancelled", CANCEL_REASON.maintenance]);
  assert.equal(h.service.records()[0]!.reason, HELD_REASON.maintenance);
  assert.equal(h.service.threadState(thread.id).compacting, true);
  assert.equal(h.service.status().watchedCount, 0);
  h.history.get(thread.id)!.push(message(thread.id, "compaction", 13, "Compaction complete."), compacted(thread.id, "compaction", 14), turn(thread.id, "compaction", 15, true));
  thread.status = "idle"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await h.service.refresh();
  await h.waitForRecord(thread.id, "nudged");
  assert.deepEqual(h.classified, ["Reply before compaction"]);
  const second = h.continuation!.latest(thread.id)!;
  assert.notEqual(second.nudgeId, first.nudgeId);
  assert.deepEqual([second.state, second.messageId], ["pending", first.messageId]);
  assert.deepEqual(h.continuation!.snapshot(thread.id).log.map(entry => [entry.event, entry.reason]),
    [["scheduled", SCHEDULED_REASON], ["cancelled", CANCEL_REASON.maintenance], ["scheduled", SCHEDULED_REASON]]);
});

test("a replacement detector with the same id does not reuse the previous detector's held judgment", async t => {
  const h = fixture(1, undefined, true); t.after(() => { h.continuation!.dispose(); return h.service.dispose(); });
  const thread = h.threads[0]!;
  await h.continuation!.start(); await h.service.start();
  await h.finish(0, "Reply before detector replacement");
  await h.waitForRecord(thread.id, "nudged");
  let replacementCalls = 0;
  h.service.configure({ id: "fixture", classify: async () => { replacementCalls++; return judgment("finished"); } });
  h.history.get(thread.id)!.push(compactRequest(thread.id, 10), turn(thread.id, "compaction", 11), accepted(thread.id, "compaction", 12, "creq-10"));
  thread.status = "active"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.active", { thread });
  assert.equal(h.service.records()[0]!.reason, HELD_REASON.maintenance);
  h.history.get(thread.id)!.push(message(thread.id, "compaction", 13, "Compaction complete."), compacted(thread.id, "compaction", 14), turn(thread.id, "compaction", 15, true));
  thread.status = "idle"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  const record = await h.waitForRecord(thread.id, "finished");
  assert.equal(replacementCalls, 1);
  assert.equal(record.classification, "finished");
  assert.deepEqual(h.continuation!.snapshot(thread.id).pending, []);
});

test("a /compact turn aborts the last reply's in-flight judgment; the compaction reply is never judged", async t => {
  const slow = deferred<FinalMessageJudgment>();
  let calls = 0;
  const h = fixture(1, async () => ++calls === 1 ? slow.promise : judgment("finished")); t.after(() => h.service.dispose());
  const thread = h.threads[0]!, id = thread.id;
  await h.service.start();
  await h.finish(0, "Reply before compaction");
  assert.equal(h.classified.length, 1);
  h.history.get(id)!.push(compactRequest(id, 10), turn(id, "compaction", 11));
  thread.status = "active"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.active", { thread });
  assert.equal(h.signals[0]?.aborted, true);
  assert.equal(h.service.records()[0]!.reason, HELD_REASON.maintenance);
  slow.resolve(judgment("blocker"));
  h.history.get(id)!.push(accepted(id, "compaction", 12, "creq-10"), message(id, "compaction", 13, "Compaction complete."), compacted(id, "compaction", 14), turn(id, "compaction", 15, true));
  thread.status = "idle"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await h.waitForRecord(id, "finished");
  assert.deepEqual(h.classified, ["Reply before compaction", "Reply before compaction"]);
  assert.equal(h.reports.length, 0);
});

test("after /compact, a reply whose nudge you cancelled or whose thread you stopped is not judged again", async t => {
  const h = fixture(2, undefined, true); t.after(() => { h.continuation!.dispose(); return h.service.dispose(); });
  const cancelled = h.threads[0]!, stopped = h.threads[1]!;
  await h.continuation!.start(); await h.service.start();
  await h.finish(0, "First"); await h.finish(1, "Second");
  await h.waitForRecord(cancelled.id, "nudged"); await h.waitForRecord(stopped.id, "nudged");
  h.continuation!.cancel(cancelled.id, CANCEL_REASON.countdown);
  h.history.get(cancelled.id)!.push(compactRequest(cancelled.id, 10), turn(cancelled.id, "compaction", 11), accepted(cancelled.id, "compaction", 12, "creq-10"),
    message(cancelled.id, "compaction", 13, "Compaction complete."), turn(cancelled.id, "compaction", 14, true));
  cancelled.updatedAt++;
  await h.harness.emitThreadEvent("experimental_thread.events", { thread: cancelled, sequence: 14 });
  h.history.get(stopped.id)!.push(compactRequest(stopped.id, 10), turn(stopped.id, "compaction", 11), stop(stopped.id, 12), turn(stopped.id, "compaction", 13, true));
  stopped.updatedAt++;
  await h.harness.emitThreadEvent("experimental_thread.events", { thread: stopped, sequence: 13 });
  await h.service.refresh();
  assert.deepEqual(h.counts(), { classifications: 2, sends: 0 });
  assert.equal(h.continuation!.latest(cancelled.id)?.cancelReason, CANCEL_REASON.countdown);
  assert.equal(h.service.records().find(record => record.threadId === cancelled.id)?.action, "nudged");
  assert.match(h.service.records().find(record => record.threadId === stopped.id)!.reason, /Observed manual Stop/);
  assert.deepEqual(h.continuation!.snapshot().pending, []);
});

test("a provider compaction inside the current run keeps that run, and its real ending is judged", async t => {
  const h = fixture(1, async () => judgment("finished")); t.after(() => h.service.dispose());
  const thread = h.threads[0]!, runId = `run-${thread.id}`;
  await h.service.start();
  h.history.get(thread.id)!.push(message(thread.id, runId, 2, "Halfway there"), compacted(thread.id, runId, 3));
  await h.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 3 });
  assert.equal(h.service.status().watchedCount, 1);
  await h.finish(0, "All done after compacting");
  await h.waitForRecord(thread.id, "finished");
  assert.deepEqual(h.classified, ["All done after compacting"]);
});

test("a turn another request started is a real run even while a /compact waits its turn", async t => {
  const h = fixture(1, async () => judgment("finished")); t.after(() => h.service.dispose());
  const thread = h.threads[0]!, id = thread.id, runId = `run-${id}`;
  await h.service.start();
  // The ending, then a /compact and a person's message both queued; the person's turn starts first.
  h.history.get(id)!.push(message(id, runId, 2, "First reply"), turn(id, runId, 3, true), compactRequest(id, 4), turn(id, "person", 5), accepted(id, "person", 6, "creq-person"));
  thread.status = "active"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.active", { thread });
  assert.equal(h.service.status().watchedCount, 1);
  assert.equal(h.service.threadState(id).compacting, false);
  h.history.get(id)!.push(message(id, "person", 7, "Answer to the person"), turn(id, "person", 8, true),
    turn(id, "compaction", 9), accepted(id, "compaction", 10, "creq-4"), message(id, "compaction", 11, "Compaction complete."), turn(id, "compaction", 12, true));
  thread.status = "idle"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await h.waitForRecord(id, "finished");
  assert.deepEqual(h.classified, ["Answer to the person"]);
  assert.equal(h.service.records().find(record => record.runId === runId)?.reason, "A later root execution superseded the classified ending");
});

test("a thread compacting at startup is not followed as a run; its next real run is", async t => {
  const h = fixture(1, async () => judgment("finished")); t.after(() => h.service.dispose());
  const thread = h.threads[0]!, id = thread.id;
  h.history.set(id, [turn(id, "run-1", 1), message(id, "run-1", 2, "Earlier reply"), turn(id, "run-1", 3, true),
    compactRequest(id, 4), turn(id, "compaction", 5), accepted(id, "compaction", 6, "creq-4")]);
  await h.service.start();
  assert.equal(h.service.status().watchedCount, 0);
  assert.equal(h.service.status().threads[0]!.exclusion, null);
  assert.equal(h.service.threadState(id).compacting, true);
  h.history.get(id)!.push(message(id, "compaction", 7, "Compaction complete."), compacted(id, "compaction", 8), turn(id, "compaction", 9, true));
  thread.status = "idle"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Compaction complete." });
  assert.equal(h.service.threadState(id).compacting, false);
  thread.status = "active"; thread.updatedAt++;
  h.history.get(id)!.push(turn(id, "run-2", 10));
  await h.harness.emitThreadEvent("thread.active", { thread });
  assert.equal(h.service.status().watchedCount, 1);
  h.history.get(id)!.push(message(id, "run-2", 11, "Next real reply"), turn(id, "run-2", 12, true));
  thread.status = "idle"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await h.waitForRecord(id, "finished");
  assert.deepEqual(h.classified, ["Next real reply"]);
});

function stored(id: string, threadId: string, daysAgo: number, now: number, overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return { id, threadId, projectId: "project", runId: id, messageId: `message-${id}`, messageRevision: 1, observedAt: now - daysAgo * 86_400_000,
    classification: null, action: "finished", reason: "fixture", detector: null, judgment: null, ...overrides };
}
const ACTIONS: RecoveryRecord["action"][] = ["observed", "finished", "reported", "suppressed", "nudged", "discarded", "error"];
/**
 * The v1 history view: the oldest (coverage anchor), a nudge inside the daily history, the detector's newest outcome,
 * each thread's latest, the last week. The decision log adds every other record of the last 30 days.
 */
function retentionCorpus(now: number) {
  const history = [
    stored("anchor", "thread-a", 200, now),
    stored("nudge-100d", "thread-a", 100, now, { action: "nudged", classification: "continue" }),
    stored("outcome-20d", "thread-a", 20, now, { detector: "jev-a", classification: "finished", judgment: judgment("finished") }),
    stored("recent-1d", "thread-a", 1, now),
    stored("only-50d", "thread-b", 50, now, { action: "suppressed" }),
  ];
  const logOnly = [
    stored("plain-10d", "thread-a", 10, now, { action: "suppressed" }),
    stored("outcome-29d", "thread-a", 29, now, { detector: "jev-a", classification: "finished", judgment: judgment("finished") }),
  ];
  const dropped = [
    stored("nudge-190d", "thread-a", 190, now, { action: "nudged", classification: "continue" }),
    stored("outcome-31d", "thread-a", 31, now, { detector: "jev-a", classification: "finished", judgment: judgment("finished") }),
    stored("plain-40d", "thread-a", 40, now, { action: "suppressed" }),
  ];
  return { history, logOnly, dropped };
}

test("the v1 history view keeps what the dashboard and recovery read and nothing else", () => {
  const now = Date.now();
  const { history, logOnly, dropped } = retentionCorpus(now);
  assert.deepEqual([...historyRecordIds([...dropped, ...logOnly, ...history], now)].sort(), history.map(record => record.id).sort());
});

test("startup prunes records past both the decision log and the history view, and a restart restores exactly the retained ones", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const { history, logOnly, dropped } = retentionCorpus(Date.now());
  for (const record of [...history, ...logOnly, ...dropped]) await h.bb.storage.kv.set(`recovery.records.${record.id}`, record);
  await h.service.start();
  const historyIds = history.map(record => record.id).sort();
  const storedIds = [...history, ...logOnly].map(record => record.id).sort();
  assert.deepEqual(h.service.records().map(record => record.id).sort(), historyIds);
  assert.deepEqual((await h.service.decisions({ cursor: null })).decisions.map(decision => decision.id).sort(), storedIds);
  assert.deepEqual((await h.bb.storage.kv.list("recovery.records.")).sort(), storedIds.map(id => `recovery.records.${id}`).sort());
  await h.service.dispose();
  const restarted = createRecoveryService({ bb: h.bb, controlThreadIds: emptyControls, detector: null, reportBlocker: async () => undefined });
  t.after(() => restarted.dispose());
  await restarted.start();
  assert.deepEqual(restarted.records(), h.service.records());
  assert.deepEqual((await restarted.decisions({ cursor: null })).decisions.map(decision => decision.id).sort(), storedIds);
});

test("every action's decision stays 30 days; past it only the history view's nudges remain", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const now = Date.now();
  const corpus = [stored("latest", "thread-a", 0, now), stored("anchor", "thread-a", 300, now),
    ...ACTIONS.flatMap(action => [stored(`${action}-29d`, "thread-a", 29, now, { action }), stored(`${action}-31d`, "thread-a", 31, now, { action })])];
  for (const record of corpus) await h.bb.storage.kv.set(`recovery.records.${record.id}`, record);
  await h.service.start();
  const kept = (await h.service.decisions({ cursor: null })).decisions;
  // A prior process's pending ending is retained as suppressed, never replayed.
  assert.deepEqual(kept.filter(decision => decision.id.endsWith("-29d")).map(decision => decision.id).sort(), ACTIONS.map(action => `${action}-29d`).sort());
  assert.deepEqual(kept.filter(decision => decision.id.endsWith("-31d")).map(decision => decision.id), ["nudged-31d"]);
  assert.deepEqual(h.service.records().map(record => record.id).sort(), ["anchor", "latest", "nudged-29d", "nudged-31d"]);
});

test("over a hard cap the oldest decisions go first, the history view's own last", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const now = Date.now();
  // Spread over 8–18 days ago, all past the history view's week: only the newest (thread latest) and the oldest (anchor) are its own.
  const corpus = Array.from({ length: DECISION_LIMITS.count + 3 }, (_, index) => stored(`record-${String(index).padStart(5, "0")}`, "thread-a", 8 + index / 1000, now));
  for (const record of corpus) await h.bb.storage.kv.set(`recovery.records.${record.id}`, record);
  await h.service.start();
  const ids = (await h.bb.storage.kv.list("recovery.records.")).map(key => key.slice("recovery.records.".length)).sort();
  assert.equal(ids.length, DECISION_LIMITS.count);
  const oldest = corpus.at(-1)!.id;
  // The three dropped are the oldest ones the history view does not publish; its anchor stays.
  assert.deepEqual(corpus.filter(record => !ids.includes(record.id)).map(record => record.id), corpus.slice(-4, -1).map(record => record.id));
  assert.ok(ids.includes(oldest));
});

test("a live decision keeps its judged text, every question's answer, its gate and the next ending as its outcome", async t => {
  const answered: FinalMessageJudgment = { ...judgment("finished"), questions: {
    boundary: { choice: "finished", confidence: 0.9, probabilities: { continue: 0.1, finished: 0.9, uncertainty: 0 } },
    obstacle: { choice: "none", confidence: 0.8, probabilities: { none: 0.8, blocker: 0.2, permission: 0, uncertainty: 0 } },
  } };
  const h = fixture(1, async () => answered); t.after(() => h.service.dispose());
  await h.service.start();
  const long = `Done. ${"x".repeat(30_000)}`;
  await h.finish(0, long);
  const first = await h.waitForRecord("thread-0", "finished");
  let [decision] = (await h.service.decisions({ cursor: null })).decisions;
  assert.equal(decision!.id, first.id);
  assert.equal(decision!.text, long.slice(0, 24_576)); assert.equal(decision!.textTruncated, true);
  assert.deepEqual(decision!.judgment?.questions, answered.questions);
  assert.equal(decision!.gate, "finished"); assert.equal(decision!.outcome, null);
  // The thread's next ending settles the first decision's outcome, with its classification once judged.
  const thread = h.threads[0]!;
  thread.status = "active"; thread.updatedAt++;
  h.history.get(thread.id)!.push(turn(thread.id, "run-2", 10));
  await h.harness.emitThreadEvent("thread.active", { thread });
  h.history.get(thread.id)!.push(message(thread.id, "run-2", 11, "Second reply"), turn(thread.id, "run-2", 12, true));
  thread.status = "idle"; thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await h.until(() => h.service.records().filter(record => record.action === "finished").length === 2);
  await h.service.refresh();
  [decision] = (await h.service.decisions({ cursor: null })).decisions;
  assert.deepEqual(decision!.outcome && { kind: decision!.outcome.kind, next: decision!.outcome.nextRecordId, classification: decision!.outcome.classification, action: decision!.outcome.action },
    { kind: "next-ending", next: JSON.stringify([thread.id, "run-2"]), classification: "finished", action: "finished" });
});

test("a manual Stop within the window is the decision's outcome; a decision with nothing after 24 hours settles as none", async t => {
  const h = fixture(2, async () => judgment("finished")); t.after(() => h.service.dispose());
  // Records from before the decision log (no gate) never get an outcome; this one is a logged decision.
  const old = stored("old", "thread-1", 0, Date.now() - OUTCOME_WINDOW_MS - 60_000, { gate: "finished" });
  await h.bb.storage.kv.set(`recovery.records.${old.id}`, old);
  await h.service.start();
  await h.finish(0);
  const ending = await h.waitForRecord("thread-0", "finished");
  const thread = h.threads[0]!;
  h.history.get(thread.id)!.push({ ...stop(thread.id, 20), createdAt: Date.now() });
  thread.updatedAt++;
  await h.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 20 });
  const decisions = (await h.service.decisions({ cursor: null })).decisions;
  const stopped = decisions.find(decision => decision.id === ending.id)!;
  assert.equal(stopped.outcome?.kind, "stopped"); assert.equal(stopped.outcome?.reason, CANCEL_REASON.stop);
  assert.deepEqual(decisions.find(decision => decision.id === "old")!.outcome, { kind: "none", at: old.observedAt + OUTCOME_WINDOW_MS, nextRecordId: null, classification: null, action: null, reason: null });
});

test("a nudge's text and fate are kept on its decision, and the operator cancelling it is the outcome", async t => {
  const h = fixture(1, async () => judgment("continue"), true); t.after(() => h.service.dispose());
  await h.continuation!.start();
  await h.service.start();
  await h.finish(0);
  const nudged = await h.waitForRecord("thread-0", "nudged");
  h.continuation!.cancel("thread-0", CANCEL_REASON.countdown);
  await h.service.refresh();
  const decision = (await h.service.decisions({ cursor: null })).decisions.find(row => row.id === nudged.id)!;
  assert.equal(decision.gate, "nudge-scheduled");
  assert.deepEqual(decision.nudge && { text: decision.nudge.text, state: decision.nudge.state, gate: decision.nudge.gate, reason: decision.nudge.reason },
    { text: RECOVERY_NUDGE, state: "cancelled", gate: "operator-cancel", reason: CANCEL_REASON.countdown });
  assert.equal(decision.outcome?.kind, "cancelled"); assert.equal(decision.outcome?.reason, CANCEL_REASON.countdown);
  await h.continuation!.dispose();
});

test("an ending waiting on work it started gets a late check-in; after unanswered nudges the next ending is not nudged", async t => {
  const waiting: FinalMessageJudgment = { ...judgment("continue"), questions: { waits_on: { choice: "running", confidence: 1, probabilities: { assistant: 0, running: 1, operator: 0, nothing: 0 } } } };
  const h = fixture(1, async () => waiting, true); t.after(() => { h.continuation!.dispose(); return h.service.dispose(); });
  await h.continuation!.start(); await h.service.start();
  const thread = h.threads[0]!;
  await h.finish(0, "The suite runs as a background task; I'll check the results when it finishes.");
  const first = await h.waitForRecord(thread.id, "nudged");
  const gate = async (runId: string) => (await h.service.decisions({ cursor: null })).decisions.find(row => row.runId === runId)?.gate;
  assert.equal(await gate("run-thread-0"), "check-in-scheduled");
  const checkIn = h.continuation!.latest(thread.id)!;
  assert.equal(checkIn.sendAt - checkIn.createdAt, CHECK_IN_MS);
  // The thread's nudges are admitted one after another, with nothing else reaching it in between.
  for (let sent = 0; sent < NUDGE_STREAK_LIMIT; sent++) {
    const nudge = sent === 0 ? checkIn : await h.continuation!.schedule(first);
    h.continuation!.decide(makeMessageDispatchHookContext({ thread: { id: thread.id, status: "idle" }, initiator: "user", input: { text: RECOVERY_NUDGE },
      experimental_submission: { pluginId: h.bb.pluginId, data: { continuationNudge: nudge.nudgeId } } }));
  }
  const seq = Math.max(...h.history.get(thread.id)!.map(row => row.seq));
  h.history.get(thread.id)!.push(turn(thread.id, "run-2", seq + 1), message(thread.id, "run-2", seq + 2, "Still running."), turn(thread.id, "run-2", seq + 3, true));
  thread.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await h.until(() => h.service.records().some(row => row.runId === "run-2" && row.action === "suppressed"));
  assert.equal(await gate("run-2"), "nudge-streak");
  assert.equal(h.continuation!.latest(thread.id)!.runId, "run-thread-0");
});

test("a wrong label persists with its decision across restarts until cleared, and pages are stable and complete", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const now = Date.now();
  const corpus = Array.from({ length: 450 }, (_, index) => stored(`record-${index}`, "thread-a", index / 100, now));
  for (const record of corpus) await h.bb.storage.kv.set(`recovery.records.${record.id}`, record);
  await h.service.start();
  const labelled = await h.service.label("record-7", { label: "wrong", note: "was still working", by: "fixture-reviewer", at: now });
  assert.equal(labelled?.label?.by, "fixture-reviewer");
  assert.equal(await h.service.label("missing", { label: "wrong", note: null, by: "fixture-reviewer", at: now }), null);
  await h.service.dispose();
  const restarted = createRecoveryService({ bb: h.bb, controlThreadIds: emptyControls, detector: null, reportBlocker: async () => undefined });
  t.after(() => restarted.dispose());
  await restarted.start();
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await restarted.decisions({ cursor });
    seen.push(...page.decisions.map(decision => decision.id));
    if (page.decisions.some(decision => decision.id === "record-7")) assert.deepEqual(page.decisions.find(decision => decision.id === "record-7")!.label, { label: "wrong", note: "was still working", by: "fixture-reviewer", at: now });
    cursor = page.nextCursor; pages++;
  } while (cursor !== null);
  assert.equal(pages, 3);
  // Oldest first, each once.
  assert.deepEqual(seen, [...corpus].reverse().map(record => record.id));
  const since = (await restarted.decisions({ cursor: null, since: now - 50_000_000 })).decisions;
  assert.ok(since.length > 0 && since.every(decision => decision.observedAt >= now - 50_000_000));
  await restarted.label("record-7", null);
  assert.equal((await restarted.decisions({ cursor: null, since: corpus[7]!.observedAt })).decisions.find(decision => decision.id === "record-7")!.label, null);
});

test("an unchanged pause setting is not written again", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  await h.service.start();
  const writes: string[] = [];
  const kv = h.bb.storage.kv;
  const set = kv.set.bind(kv);
  kv.set = async (key, value) => { writes.push(key); await set(key, value); };
  await h.service.setPaused(true);
  await h.service.setPaused(true);
  await h.service.setPaused(false);
  assert.deepEqual(writes, ["recovery.paused", "recovery.paused"]);
});
