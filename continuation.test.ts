import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { ADMITTED_REASON, createContinuation, SCHEDULED_REASON, type Continuation } from "./continuation.js";
import { CANCEL_REASON, WITHHELD_REASON } from "./continuation-copy.js";
import { RECOVERY_NUDGE, type RecoveryCursor, type RecoveryRecord } from "./recovery-contract.js";

const threadId = "thr_one";
const otherId = "thr_two";
function ending(id = threadId): RecoveryRecord {
  return { id: `record-${id}`, threadId: id, projectId: "project", runId: "run-1", messageId: "message-1", messageRevision: 7,
    observedAt: 0, classification: "continue", action: "nudged", reason: "", detector: "fixture", judgment: null };
}
const freshCursor = (): RecoveryCursor => ({ runId: "run-1", messageId: "message-1", messageRevision: 7, knownStop: false, waitingForWorkflow: false });

function fixture() {
  let clock = 1_000;
  const cursors = new Map<string, RecoveryCursor>([[threadId, freshCursor()], [otherId, freshCursor()]]);
  const sends: Array<{ threadId: string; pluginSubmission?: unknown; mode?: string; input?: unknown }> = [];
  const deletes: string[] = [];
  const timers = new Map<number, { threadId: string | null; callback: () => void }>();
  let nextTimer = 0;
  const core = { status: "idle" as "idle" | "active", delivery: "sent" as "sent" | "queued", paused: false };
  const changes: string[] = [];
  const { bb, harness } = createFakePluginHost({ sdk: { threads: {
    send: async args => {
      sends.push({ ...args });
      // Core runs the hook pass synchronously on the initial attempt.
      const decision = continuation.decide(makeMessageDispatchHookContext({ thread: { id: args.threadId, status: core.status }, initiator: "system",
        attempt: core.status === "idle" ? "start-turn" : "join-turn", input: { text: RECOVERY_NUDGE },
        experimental_submission: args.pluginSubmission ?? null }));
      if (decision?.action === "reject") throw new Error(decision.message);
      if (core.delivery === "queued") return { ok: true, delivery: "queued", queuedMessage: makeQueueEntry({ id: "queued_nudge", threadId: args.threadId, originPluginId: bb.pluginId }) };
      return { ok: true, delivery: "sent" } as never;
    },
    queuedMessages: { delete: async ({ queuedMessageId }) => { deletes.push(queuedMessageId); return { ok: true }; } },
  } } });
  // Timers remember which thread scheduled them (the last scheduled record), so tests can fire one thread's timer.
  let scheduling: string | null = null;
  const make = () => createContinuation({ bb, cursor: id => cursors.get(id) ?? null, paused: () => core.paused, now: () => clock,
    setTimer: (callback, ms) => { assert.equal(ms, 20_000); const id = ++nextTimer; timers.set(id, { threadId: scheduling, callback }); return id; },
    clearTimer: handle => { timers.delete(handle as number); }, onChange: id => { changes.push(id); } });
  let continuation: Continuation = make();
  /** Fires every pending timer (or only one thread's) as if the delay elapsed, then waits for the resulting sends. */
  async function elapse(only?: string) {
    clock += 20_000;
    for (const [id, timer] of [...timers]) {
      if (only !== undefined && timer.threadId !== only) continue;
      timers.delete(id);
      timer.callback();
    }
    await continuation.flush();
  }
  async function schedule(id = threadId) {
    scheduling = id;
    try { return await continuation.schedule(ending(id)); } finally { scheduling = null; }
  }
  return { bb, harness, cursors, sends, deletes, timers, core, changes, elapse, schedule,
    get continuation() { return continuation; },
    restart: () => { continuation = make(); return continuation; } };
}

async function started() {
  const h = fixture();
  await h.continuation.start();
  return h;
}
const reasons = (continuation: Continuation, id?: string) => continuation.snapshot(id).log.map(entry => [entry.event, entry.reason]);
const SCHEDULED = ["scheduled", SCHEDULED_REASON];

test("every thread is on by default once state loads; nothing is on before", async () => {
  const h = fixture();
  assert.equal(h.continuation.enabled(threadId), false);
  await h.continuation.start();
  assert.equal(h.continuation.enabled(threadId), true);
  assert.equal(h.continuation.enabled("thr_never_seen"), true);
});

test("a continue ending schedules; nothing is sent before the delay, then one start send with the submission and no sendAt", async () => {
  const h = await started();
  const nudge = await h.schedule();
  assert.equal(nudge.state, "pending");
  assert.equal(nudge.sendAt, 21_000);
  assert.equal(h.sends.length, 0);
  assert.equal(h.timers.size, 1);
  await h.elapse();
  assert.equal(h.sends.length, 1);
  const send = h.sends[0]!;
  assert.equal(send.threadId, threadId);
  assert.equal(send.mode, "start");
  assert.equal("sendAt" in send, false);
  assert.deepEqual(send.pluginSubmission, { pluginId: h.bb.pluginId, data: { continuationNudge: nudge.nudgeId } });
  assert.deepEqual(send.input, [{ type: "text", text: RECOVERY_NUDGE, mentions: [] }]);
  assert.deepEqual(reasons(h.continuation), [SCHEDULED, ["sent", ADMITTED_REASON]]);
});

test("two threads are nudged independently, each on its own timer", async () => {
  const h = await started();
  const first = await h.schedule(threadId);
  const second = await h.schedule(otherId);
  assert.equal(h.timers.size, 2);
  assert.deepEqual(h.continuation.snapshot().pending.map(nudge => nudge.threadId).sort(), [threadId, otherId].sort());
  // A person replying on one thread cancels only that thread's nudge.
  assert.equal(h.continuation.decide(makeMessageDispatchHookContext({ thread: { id: threadId, status: "idle" }, initiator: "user" })), null);
  assert.equal(h.continuation.latest(threadId)?.state, "cancelled");
  assert.equal(h.continuation.latest(otherId)?.state, "pending");
  assert.equal(h.timers.size, 1);
  await h.elapse();
  assert.deepEqual(h.sends.map(send => send.threadId), [otherId]);
  assert.equal(h.continuation.latest(otherId)?.state, "sent");
  assert.deepEqual(reasons(h.continuation, threadId), [SCHEDULED, ["cancelled", `${CANCEL_REASON.freshActivity}: user`]]);
  assert.deepEqual(reasons(h.continuation, otherId), [SCHEDULED, ["sent", ADMITTED_REASON]]);
  assert.notEqual(first.nudgeId, second.nudgeId);
});

test("a thread turned off is never nudged, and the choice persists across restarts", async () => {
  const h = await started();
  await h.continuation.setEnabled(otherId, false);
  assert.equal(await h.bb.storage.kv.get("continuation.off.thr_two"), true);
  const nudge = await h.schedule(otherId);
  assert.equal(nudge.state, "cancelled");
  assert.equal(nudge.cancelReason, CANCEL_REASON.turnedOff);
  assert.equal(h.timers.size, 0);
  await h.elapse();
  assert.equal(h.sends.length, 0);
  h.continuation.dispose();
  const restarted = h.restart();
  await restarted.start();
  assert.equal(restarted.enabled(otherId), false);
  assert.equal(restarted.enabled(threadId), true);
  assert.deepEqual(restarted.snapshot().off, [otherId]);
  await restarted.setEnabled(otherId, true);
  assert.equal(await h.bb.storage.kv.get("continuation.off.thr_two"), false);
  assert.equal(restarted.enabled(otherId), true);
});

test("turning a thread off cancels its pending nudge with reason 'turned off'; other threads keep theirs", async () => {
  const h = await started();
  await h.schedule(threadId);
  await h.schedule(otherId);
  await h.continuation.setEnabled(threadId, false);
  assert.equal(h.continuation.latest(threadId)?.state, "cancelled");
  assert.equal(h.continuation.latest(threadId)?.cancelReason, "turned off");
  assert.equal(h.continuation.latest(otherId)?.state, "pending");
  assert.ok(h.changes.includes(threadId));
  await h.elapse();
  assert.deepEqual(h.sends.map(send => send.threadId), [otherId]);
});

test("a global pause schedules nothing and withholds a nudge already counting down", async () => {
  const h = await started();
  await h.schedule(threadId);
  h.core.paused = true;
  const paused = await h.schedule(otherId);
  assert.equal(paused.state, "cancelled");
  assert.equal(paused.cancelReason, CANCEL_REASON.paused);
  await h.elapse();
  assert.equal(h.continuation.latest(threadId)?.state, "withheld");
  assert.equal(h.continuation.latest(threadId)?.cancelReason, "auto-continue is paused");
  h.core.paused = false;
  await h.schedule(otherId);
  h.continuation.cancelAll(CANCEL_REASON.paused);
  assert.equal(h.continuation.snapshot().pending.length, 0);
  assert.equal(h.timers.size, 0);
});

test("stop evidence cancels only the named thread's pending nudge; latest keeps the cancelled nudge", async () => {
  const h = await started();
  const nudge = await h.schedule();
  assert.deepEqual(h.continuation.latest(threadId), nudge);
  assert.equal(h.continuation.latest(otherId), null);
  h.continuation.cancel(otherId, CANCEL_REASON.stop);
  assert.equal(h.continuation.latest(threadId)?.state, "pending");
  h.continuation.cancel(threadId, CANCEL_REASON.stop);
  assert.deepEqual(h.continuation.latest(threadId), { ...nudge, state: "cancelled", cancelReason: CANCEL_REASON.stop });
  // A second cancel is a no-op and records nothing.
  h.continuation.cancel(threadId, CANCEL_REASON.countdown);
  assert.deepEqual(reasons(h.continuation), [SCHEDULED, ["cancelled", CANCEL_REASON.stop]]);
  await h.elapse();
  assert.equal(h.sends.length, 0);
});

test("a newer root turn, a busy thread or a running workflow withholds the nudge at send time, with plain copy in the reject", async () => {
  const cases: Array<[string, (cursors: Map<string, RecoveryCursor>, core: { status: "idle" | "active" }) => void, string]> = [
    ["newer root", cursors => { cursors.set(threadId, { runId: "run-2", messageId: null, messageRevision: null, knownStop: false, waitingForWorkflow: false }); }, WITHHELD_REASON.newerRun],
    ["busy", (_cursors, core) => { core.status = "active"; }, `${WITHHELD_REASON.notIdle}: active`],
    // A workflow step started during the countdown: the thread waits on it, not on a nudge.
    ["workflow", cursors => { cursors.set(threadId, { ...freshCursor(), waitingForWorkflow: true }); }, WITHHELD_REASON.workflow],
  ];
  for (const [name, setup, reason] of cases) {
    const h = await started();
    await h.schedule();
    setup(h.cursors, h.core);
    await h.elapse();
    assert.equal(h.sends.length, 1, name);
    assert.deepEqual(reasons(h.continuation), [SCHEDULED, ["withheld", reason]], name);
  }
  const h = await started();
  const nudge = await h.schedule();
  h.core.status = "active";
  const decision = h.continuation.decide(makeMessageDispatchHookContext({ thread: { id: threadId, status: "active" }, attempt: "join-turn",
    experimental_submission: { pluginId: h.bb.pluginId, data: { continuationNudge: nudge.nudgeId } } }));
  assert.deepEqual(decision, { action: "reject", message: "Nudger didn't send its nudge: the agent was busy." });
});

test("a restarted plugin cancels every persisted pending nudge", async () => {
  const h = await started();
  const first = await h.schedule(threadId);
  const second = await h.schedule(otherId);
  await h.continuation.flush();
  h.continuation.dispose();
  const restarted = h.restart();
  // Before persisted state loads, this plugin's submissions are never admitted.
  assert.equal(restarted.decide(makeMessageDispatchHookContext({ thread: { id: threadId, status: "idle" },
    experimental_submission: { pluginId: h.bb.pluginId, data: { continuationNudge: first.nudgeId } } }))?.action, "reject");
  await restarted.start();
  await restarted.flush();
  assert.deepEqual(restarted.snapshot().pending, []);
  for (const nudge of [first, second]) {
    assert.deepEqual(restarted.latest(nudge.threadId), { ...nudge, state: "cancelled", cancelReason: CANCEL_REASON.restarted });
    assert.equal((await h.bb.storage.kv.get<{ state: string }>(`continuation.nudge.${nudge.threadId}`))?.state, "cancelled");
  }
  await h.elapse();
  assert.equal(h.sends.length, 0);
});

test("a dispatch carrying a queued row from this plugin without a submission is rejected (fail closed)", async () => {
  const h = await started();
  await h.schedule();
  const decision = h.continuation.decide(makeMessageDispatchHookContext({ thread: { id: threadId, status: "idle" }, initiator: "system",
    input: { text: RECOVERY_NUDGE }, queuedMessages: [makeQueueEntry({ id: "queued_nudge", threadId, originPluginId: h.bb.pluginId, sendAt: 21_000 })] }));
  assert.deepEqual(decision, { action: "reject", message: "Nudger didn't send its nudge: something changed at the last second." });
  assert.deepEqual(reasons(h.continuation).at(-1), ["withheld", "unrecognized queued continuation"]);
  await h.elapse();
  assert.equal(h.sends.length, 0);
  // With no pending nudge, such a row is still rejected, on any thread.
  assert.equal(h.continuation.decide(makeMessageDispatchHookContext({ thread: { id: otherId, status: "idle" },
    queuedMessages: [makeQueueEntry({ id: "queued_other", threadId: otherId, originPluginId: h.bb.pluginId })] }))?.action, "reject");
});

test("a submission for a stale or foreign nudge is rejected", async () => {
  const h = await started();
  const nudge = await h.schedule(threadId);
  assert.equal(h.continuation.decide(makeMessageDispatchHookContext({ thread: { id: threadId, status: "idle" },
    experimental_submission: { pluginId: h.bb.pluginId, data: { continuationNudge: "unknown" } } }))?.action, "reject");
  // The right nudge id aimed at another thread is withheld.
  assert.equal(h.continuation.decide(makeMessageDispatchHookContext({ thread: { id: otherId, status: "idle" },
    experimental_submission: { pluginId: h.bb.pluginId, data: { continuationNudge: nudge.nudgeId } } }))?.action, "reject");
  assert.equal(h.continuation.latest(threadId)?.state, "withheld");
});

test("core queuing the nudge instead of starting it withholds it and deletes the row", async () => {
  const h = await started();
  await h.schedule();
  h.core.delivery = "queued";
  await h.elapse();
  assert.deepEqual(reasons(h.continuation).at(-1), ["withheld", WITHHELD_REASON.queued]);
  assert.deepEqual(h.deletes, ["queued_nudge"]);
});

test("each thread counts the nudges it received, not ones cancelled or queued, and the count survives a restart", async () => {
  const h = await started();
  await h.schedule(threadId); await h.elapse();
  await h.schedule(threadId); await h.elapse();
  await h.schedule(threadId); h.continuation.cancel(threadId, CANCEL_REASON.countdown);
  h.core.delivery = "queued";
  await h.schedule(threadId); await h.elapse();
  h.core.delivery = "sent";
  await h.schedule(otherId); await h.elapse();
  assert.equal(h.continuation.sentCount(threadId), 2);
  assert.equal(h.continuation.sentCount(otherId), 1);
  assert.equal(h.continuation.sentCount("thr_never_nudged"), 0);
  await h.continuation.flush();
  h.continuation.dispose();
  const restarted = h.restart();
  await restarted.start();
  assert.equal(restarted.sentCount(threadId), 2);
  // Once stored, the counts are the record: a log that has since dropped old entries does not lower them.
  await h.bb.storage.kv.set("continuation.log", []);
  restarted.dispose();
  const again = h.restart();
  await again.start();
  assert.equal(again.sentCount(threadId), 2);
});

test("the first start after the counter ships counts sends already in the log", async () => {
  const h = fixture();
  const entry = (event: string, nudgeId: string, id = threadId) => ({ at: 1, event, nudgeId, threadId: id, reason: null });
  await h.bb.storage.kv.set("continuation.log", [entry("scheduled", "a"), entry("sent", "a"), entry("sent", "b"), entry("withheld", "b"), entry("sent", "c", otherId)]);
  await h.continuation.start();
  assert.equal(h.continuation.sentCount(threadId), 1);
  assert.equal(h.continuation.sentCount(otherId), 1);
  await h.continuation.flush();
  assert.deepEqual(await h.bb.storage.kv.get("continuation.sentCounts"), { [threadId]: 1, [otherId]: 1 });
});

test("dispose clears every timer; a newer ending supersedes the thread's pending nudge", async () => {
  const disposed = await started();
  await disposed.schedule(threadId);
  await disposed.schedule(otherId);
  disposed.continuation.dispose();
  assert.equal(disposed.timers.size, 0);
  await disposed.elapse();
  assert.equal(disposed.sends.length, 0);

  const h = await started();
  const first = await h.schedule();
  const second = await h.schedule();
  assert.equal(h.timers.size, 1);
  assert.deepEqual(reasons(h.continuation), [SCHEDULED, ["cancelled", CANCEL_REASON.superseded], SCHEDULED]);
  assert.equal(h.continuation.latest(threadId)?.nudgeId, second.nudgeId);
  assert.notEqual(first.nudgeId, second.nudgeId);
  await h.elapse();
  assert.deepEqual(h.sends.map(send => send.pluginSubmission), [{ pluginId: h.bb.pluginId, data: { continuationNudge: second.nudgeId } }]);
});

test("the log is written once per burst and flushed by dispose; a restart restores it without rewriting unchanged counts", async () => {
  const h = await started();
  const writes: string[] = [];
  const kv = h.bb.storage.kv;
  const set = kv.set.bind(kv);
  kv.set = async (key, value) => { writes.push(key); await set(key, value); };
  await h.schedule();
  h.continuation.cancel(threadId, CANCEL_REASON.countdown);
  await h.schedule();
  await h.continuation.dispose();
  // Each nudge decision is written as it happens; the three log entries share one write.
  assert.deepEqual(writes, [`continuation.nudge.${threadId}`, `continuation.nudge.${threadId}`, `continuation.nudge.${threadId}`, "continuation.log"]);
  writes.length = 0;
  const restarted = h.restart();
  await restarted.start();
  await restarted.dispose();
  assert.deepEqual(reasons(restarted), [SCHEDULED, ["cancelled", CANCEL_REASON.countdown], SCHEDULED, ["cancelled", CANCEL_REASON.restarted]]);
  // Only the restart's own decision is new: the stored sent counts are not rewritten.
  assert.deepEqual(writes, [`continuation.nudge.${threadId}`, "continuation.log"]);
});
