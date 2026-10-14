import assert from "node:assert/strict";
import { test } from "node:test";
import { RECOVERY_NUDGE, type FinalMessageClassifier, type FinalMessageJudgment, type RecoveryBlocker, type RecoveryRecord, type RecoveryService, type ThreadEventRow } from "./recovery-contract.js";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createRecoveryService, retainedRecordIds } from "./recovery.js";
import { createContinuation, SCHEDULED_REASON, type Continuation } from "./continuation.js";
import { CANCEL_REASON, HELD_REASON, WITHHELD_REASON } from "./continuation-copy.js";
import { WORKFLOW_SETTLE_MS } from "./workflow-steps.js";

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
  const continuation: Continuation | null = withContinuation ? createContinuation({ bb, cursor: threadId => service.cursor(threadId) }) : null;
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
    assert.deepEqual(h.service.cursor(record.threadId), { runId: record.runId, messageId: record.messageId, messageRevision: record.messageRevision, knownStop: false, waitingForWorkflow: false });
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
  assert.deepEqual(h.service.threadState(owner.id).workflow, { running: 1, settlingUntil: null });
  await h.finish(0, "The fixture setup is complete; the workflow is running…");
  const held = await h.waitForRecord(owner.id, "suppressed");
  assert.equal(held.reason, HELD_REASON.workflow);
  assert.equal(h.service.cursor(owner.id)?.waitingForWorkflow, true);
  // The step ends; the owner still waits through the settle window for a next step or the finishing message.
  step.status = "idle"; step.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread: step, lastAssistantText: null });
  assert.deepEqual(h.service.threadState(owner.id).workflow, { running: 0, settlingUntil: 1_000 + WORKFLOW_SETTLE_MS });
  t.mock.timers.tick(WORKFLOW_SETTLE_MS - 1);
  await h.service.refresh();
  assert.deepEqual(h.counts(), { classifications: 0, sends: 0 });
  t.mock.timers.tick(1);
  const nudged = await h.waitForRecord(owner.id, "nudged");
  assert.equal(nudged.id, held.id);
  assert.deepEqual(h.classified, ["The fixture setup is complete; the workflow is running…"]);
  assert.equal(h.continuation!.latest(owner.id)?.state, "pending");
  assert.equal(h.service.threadState(owner.id).workflow, null);
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
  t.mock.timers.tick(WORKFLOW_SETTLE_MS);
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
  assert.equal(h.service.cursor(owner.id)?.waitingForWorkflow, true);
  // Core runs the dispatch hook when the countdown sends.
  const decision = h.continuation!.decide(makeMessageDispatchHookContext({ thread: { id: owner.id, status: "idle" }, initiator: "system", input: { text: RECOVERY_NUDGE },
    experimental_submission: { pluginId: h.bb.pluginId, data: { continuationNudge: nudge.nudgeId } } }));
  assert.deepEqual(decision, { action: "reject", message: "Nudger didn't send its nudge: its workflow was running." });
  const withheld = h.continuation!.latest(owner.id)!;
  assert.deepEqual([withheld.state, withheld.cancelReason], ["withheld", WITHHELD_REASON.workflow]);
  step.status = "idle"; step.updatedAt++;
  await h.harness.emitThreadEvent("thread.idle", { thread: step, lastAssistantText: null });
  t.mock.timers.tick(WORKFLOW_SETTLE_MS);
  await h.service.refresh();
  await h.waitForRecord(owner.id, "nudged");
  const again = h.continuation!.latest(owner.id)!;
  assert.notEqual(again.nudgeId, nudge.nudgeId);
  assert.deepEqual([again.state, again.messageId], ["pending", nudge.messageId]);
  assert.deepEqual(h.counts(), { classifications: 1, sends: 0 });
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
  assert.deepEqual(h.service.cursor(thread.id), { runId, messageId: "message-349", messageRevision: 349, knownStop: false, waitingForWorkflow: false });
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
/** Kept: the oldest (coverage anchor), a nudge inside the daily history, the detector's newest outcome, each thread's latest, the last week. */
function retentionCorpus(now: number) {
  const kept = [
    stored("anchor", "thread-a", 200, now),
    stored("nudge-100d", "thread-a", 100, now, { action: "nudged", classification: "continue" }),
    stored("outcome-20d", "thread-a", 20, now, { detector: "jev-a", classification: "finished", judgment: judgment("finished") }),
    stored("recent-1d", "thread-a", 1, now),
    stored("only-50d", "thread-b", 50, now, { action: "suppressed" }),
  ];
  const dropped = [
    stored("nudge-190d", "thread-a", 190, now, { action: "nudged", classification: "continue" }),
    stored("outcome-30d", "thread-a", 30, now, { detector: "jev-a", classification: "finished", judgment: judgment("finished") }),
    stored("plain-10d", "thread-a", 10, now, { action: "suppressed" }),
  ];
  return { kept, dropped };
}

test("retention keeps what the dashboard and recovery read and nothing else", () => {
  const now = Date.now();
  const { kept, dropped } = retentionCorpus(now);
  assert.deepEqual([...retainedRecordIds([...dropped, ...kept], now)].sort(), kept.map(record => record.id).sort());
});

test("startup prunes records past retention from storage, and a restart restores exactly the retained ones", async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const { kept, dropped } = retentionCorpus(Date.now());
  for (const record of [...kept, ...dropped]) await h.bb.storage.kv.set(`recovery.records.${record.id}`, record);
  await h.service.start();
  const keptIds = kept.map(record => record.id).sort();
  assert.deepEqual(h.service.records().map(record => record.id).sort(), keptIds);
  assert.deepEqual((await h.bb.storage.kv.list("recovery.records.")).sort(), keptIds.map(id => `recovery.records.${id}`).sort());
  await h.service.dispose();
  const restarted = createRecoveryService({ bb: h.bb, controlThreadIds: emptyControls, detector: null, reportBlocker: async () => undefined });
  t.after(() => restarted.dispose());
  await restarted.start();
  assert.deepEqual(restarted.records(), h.service.records());
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
