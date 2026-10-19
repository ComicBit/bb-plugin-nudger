import assert from "node:assert/strict";
import { test } from "node:test";
import { continuationStatus, type ContinuationStatusInput } from "./continuation-status.js";
import { CANCEL_REASON, countdownLine, HELD_REASON, JEV_NO_CREDITS, nudgeRejectMessage, WITHHELD_REASON } from "./continuation-copy.js";
import type { Nudge } from "./continuation.js";
import type { RecoveryInventoryThread, RecoveryRecord, RecoveryWorkflowWait } from "./recovery-contract.js";

const threadId = "thr_watched";
const JEV = "typesafe-jev-1.13.0";
const NOW = 50_000;

function inventory(overrides: Partial<RecoveryInventoryThread> = {}): RecoveryInventoryThread {
  return { id: threadId, projectId: "project", title: null, status: "idle", hostId: null, visibility: "visible", parentThreadId: null, watched: false, exclusion: null, ...overrides };
}
function ending(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return { id: "record", threadId, projectId: "project", runId: "run-1", messageId: "message-1", messageRevision: 7, observedAt: 1_000,
    classification: "continue", action: "nudged", reason: "Continuation scheduled; admission checked at send time", detector: JEV, judgment: null, ...overrides };
}
function nudged(overrides: Partial<Nudge> = {}): Nudge {
  return { nudgeId: "nudge", threadId, runId: "run-1", messageId: "message-1", messageRevision: 7, sendAt: 41_000, createdAt: 21_000, state: "pending", cancelReason: null, ...overrides };
}
interface Case { thread?: RecoveryInventoryThread | null; record?: RecoveryRecord | null; nudge?: Nudge | null; enabled?: boolean; currentRunId?: string | null; classifying?: boolean; paused?: boolean; ownThread?: boolean; detectorId?: string | null; nudgeCount?: number; workflow?: RecoveryWorkflowWait | null; compacting?: boolean }
function input(options: Case = {}): ContinuationStatusInput {
  return { threadId, now: NOW, ownThread: options.ownThread ?? false, enabled: options.enabled ?? true, nudge: options.nudge ?? null, nudgeCount: options.nudgeCount ?? 0,
    recovery: { thread: options.thread === undefined ? inventory() : options.thread, currentRunId: options.currentRunId === undefined ? "run-1" : options.currentRunId,
      latestRecord: options.record ?? null, classifying: options.classifying ?? true, paused: options.paused ?? false,
      detectorId: options.detectorId === undefined ? JEV : options.detectorId, workflow: options.workflow ?? null, compacting: options.compacting ?? false } };
}
const copy = (options: Case) => { const { text, detail } = continuationStatus(input(options)); return [text, detail]; };
const running = inventory({ status: "active", watched: true });

test("a pending nudge is a countdown over the full delay; a scheduled check-in is marked as one", () => {
  assert.deepEqual(continuationStatus(input({ record: ending(), nudge: nudged() })),
    { state: "countdown", sendAt: 41_000, totalMs: 20_000, checkIn: false, text: null, detail: null, updatedAt: NOW, nudgeCount: 0 });
  assert.equal(continuationStatus(input({ record: ending({ gate: "check-in-scheduled" }), nudge: nudged() })).checkIn, true);
  // A check-in gate on an older run says nothing about this nudge.
  assert.equal(continuationStatus(input({ record: ending({ gate: "check-in-scheduled", runId: "run-0" }), nudge: nudged() })).checkIn, false);
  assert.deepEqual(countdownLine(12, false), { text: "Continuing in 12s", detail: "The agent stopped before finishing" });
});

test("a thread turned off shows only its toggle, even mid-countdown", () => {
  assert.deepEqual(continuationStatus(input({ enabled: false, record: ending(), nudge: nudged(), nudgeCount: 3 })),
    { state: "off", sendAt: null, totalMs: null, checkIn: false, text: null, detail: null, updatedAt: NOW, nudgeCount: 3 });
  assert.equal(continuationStatus(input({ enabled: false, thread: inventory({ exclusion: "Observed manual Stop; waits for your next message to re-arm" }) })).state, "off");
});

test("each internal condition reads as its exact copy", () => {
  const cases: Array<[string, Case, [string, string | null]]> = [
    ["agent running", { thread: running, currentRunId: "run-2", record: ending({ classification: "finished", action: "finished" }) }, ["Watching", "I'll check the reply when the agent stops"]],
    ["classifying", { record: ending({ classification: null, action: "observed" }) }, ["Reading the reply…", null]],
    ["handed to scheduling", { record: ending() }, ["Reading the reply…", null]],
    ["sent", { record: ending(), nudge: nudged({ state: "sent" }) }, ["Nudged to continue", null]],
    ["running after a sent nudge", { record: ending(), nudge: nudged({ state: "sent" }), currentRunId: "run-2", thread: running }, ["Nudged to continue", "Watching"]],
    ["finished", { record: ending({ classification: "finished", action: "finished" }) }, ["Agent finished", null]],
    ["blocker", { record: ending({ classification: "blocker", action: "reported" }) }, ["The agent is stuck.", "Added to Needs your attention"]],
    ["permission", { record: ending({ classification: "permission", action: "reported" }) }, ["The agent needs a permission.", "Added to Needs your attention"]],
    ["uncertainty", { record: ending({ classification: "uncertainty", action: "reported" }) }, ["The agent needs your answer.", "Added to Needs your attention"]],
    ["person replied", { record: ending(), nudge: nudged({ state: "cancelled", cancelReason: `${CANCEL_REASON.freshActivity}: user` }) }, ["You replied", "No nudge sent"]],
    ["Cancel button", { record: ending(), nudge: nudged({ state: "cancelled", cancelReason: CANCEL_REASON.countdown }) }, ["Nudge cancelled", null]],
    ["Stop exclusion", { record: ending(), thread: inventory({ exclusion: "Observed manual Stop; waits for your next message to re-arm" }) }, ["Paused after Stop", "Your next message turns it back on"]],
    ["superseded (recovery)", { record: ending({ classification: null, action: "suppressed", reason: "A later root execution superseded the classified ending" }) }, ["A new run started", "No nudge sent"]],
    ["superseded (nudge)", { record: ending(), nudge: nudged({ state: "cancelled", cancelReason: CANCEL_REASON.superseded }) }, ["A new run started", "No nudge sent"]],
    ["withheld: newer turn", { record: ending(), nudge: nudged({ state: "withheld", cancelReason: WITHHELD_REASON.newerRun }) }, ["The conversation moved on", "No nudge sent"]],
    ["withheld: message changed", { record: ending(), nudge: nudged({ state: "withheld", cancelReason: WITHHELD_REASON.messageChanged }) }, ["The conversation moved on", "No nudge sent"]],
    ["withheld: not idle", { record: ending(), nudge: nudged({ state: "withheld", cancelReason: `${WITHHELD_REASON.notIdle}: active` }) }, ["The agent was busy", "No nudge sent"]],
    ["withheld: would join", { record: ending(), nudge: nudged({ state: "withheld", cancelReason: WITHHELD_REASON.joinTurn }) }, ["The agent was busy", "No nudge sent"]],
    ["withheld: queued", { record: ending({ action: "suppressed", reason: `Continuation withheld: ${WITHHELD_REASON.queued}` }) }, ["The agent was busy", "No nudge sent"]],
    ["withheld: stop", { record: ending(), nudge: nudged({ state: "withheld", cancelReason: WITHHELD_REASON.stop }) }, ["You pressed Stop", "No nudge sent"]],
    ["withheld: anything else", { record: ending(), nudge: nudged({ state: "withheld", cancelReason: "recovery is not observing this thread" }) }, ["Something changed at the last second", "No nudge sent"]],
    ["global pause", { paused: true, classifying: false, thread: running }, ["Auto-continue paused", "Paused for every thread from the dashboard"]],
    ["no detector", { detectorId: null, classifying: false }, ["Auto-continue isn't set up", "Choose a detector in Nudger settings"]],
    ["classification error", { record: ending({ classification: null, action: "error", reason: "Final-message classification/reporting failed: timeout" }) }, ["Couldn't read the reply", "No nudge sent"]],
    ["out of credits", { record: ending({ classification: null, action: "error", reason: `Final-message classification/reporting failed: ${JEV_NO_CREDITS}` }) }, ["Jev is out of credits", "Add TypeSafe credits; no nudge sent"]],
    ["out of credits (stored before it was named)", { record: ending({ classification: null, action: "error", reason: "Final-message classification/reporting failed: Jev evaluation failed with HTTP 402" }) }, ["Jev is out of credits", "Add TypeSafe credits; no nudge sent"]],
    ["run not followable", { thread: inventory({ exclusion: "Live root-turn identity unavailable in bounded public history" }) }, ["Can't follow this run", "It won't be nudged"]],
    ["idle with no ending yet", { currentRunId: null }, ["Watching", "I'll check the next reply"]],
  ];
  for (const [name, options, expected] of cases) assert.deepEqual(copy(options), expected, name);
});

test("the dispatch reject message carries the plain withheld reason", () => {
  assert.equal(nudgeRejectMessage(`${WITHHELD_REASON.notIdle}: active`), "Nudger didn't send its nudge: the agent was busy.");
  assert.equal(nudgeRejectMessage("unrecognized queued continuation"), "Nudger didn't send its nudge: something changed at the last second.");
});

test("a thread waiting on its workflow or compacting says so, and its held endings never read as a new run or the last second", () => {
  assert.deepEqual(continuationStatus(input({ workflow: { running: 1, settlingUntil: null } })),
    { state: "waiting", sendAt: null, totalMs: null, checkIn: false, text: "Waiting for its workflow", detail: "1 step running", updatedAt: NOW, nudgeCount: 0 });
  const held = ending({ classification: null, action: "suppressed", reason: HELD_REASON.workflow });
  assert.deepEqual(copy({ workflow: { running: 3, settlingUntil: null }, record: held }), ["Waiting for its workflow", "3 steps running"]);
  assert.deepEqual(copy({ workflow: { running: 0, settlingUntil: NOW + 60_000 }, record: held }), ["Waiting for its workflow", "Finishing up"]);
  // A step started during the countdown: the countdown still shows, and the wait follows once the nudge is withheld.
  assert.equal(continuationStatus(input({ workflow: { running: 1, settlingUntil: null }, record: ending(), nudge: nudged() })).state, "countdown");
  assert.deepEqual(copy({ workflow: { running: 1, settlingUntil: null }, record: ending(), nudge: nudged({ state: "withheld", cancelReason: WITHHELD_REASON.workflow }) }), ["Waiting for its workflow", "1 step running"]);
  // The owner's own run still reads as watching while its steps work.
  assert.equal(continuationStatus(input({ thread: running, workflow: { running: 2, settlingUntil: null } })).state, "watching");

  const compactingHeld = ending({ classification: null, action: "suppressed", reason: HELD_REASON.maintenance });
  assert.deepEqual(continuationStatus(input({ thread: running, compacting: true, record: compactingHeld })),
    { state: "waiting", sendAt: null, totalMs: null, checkIn: false, text: "Compacting the conversation", detail: "I'll check the last reply after", updatedAt: NOW, nudgeCount: 0 });
  assert.deepEqual(copy({ thread: running, compacting: true, classifying: false }), ["Can't follow this run", "It won't be nudged"]);

  // After the wait, an ending that was never judged again says why no nudge went out.
  assert.deepEqual(copy({ record: held }), ["Its workflow was running", "No nudge sent"]);
  assert.deepEqual(copy({ record: ending(), nudge: nudged({ state: "withheld", cancelReason: WITHHELD_REASON.workflow }) }), ["Its workflow was running", "No nudge sent"]);
  assert.deepEqual(copy({ record: compactingHeld }), ["The conversation was compacted", "No nudge sent"]);
  assert.deepEqual(copy({ record: ending(), nudge: nudged({ state: "cancelled", cancelReason: CANCEL_REASON.maintenance }) }), ["The conversation was compacted", "No nudge sent"]);
  assert.equal(nudgeRejectMessage(WITHHELD_REASON.workflow), "Nudger didn't send its nudge: its workflow was running.");
  // The Task A record stored before this fix keeps its copy.
  assert.deepEqual(copy({ record: ending({ classification: null, action: "suppressed", reason: "A later root execution superseded the classified ending" }) }), ["A new run started", "No nudge sent"]);
});

const LEGACY_REASON = "Live public root-turn ending observed; Published @get-bb/plugin-sdk 0.6.15 has no execution-bound continuation admission coordinated with native Stop, queue precedence and accepted-fresh-user provenance, or universal provider completion interception. Automatic recovery cannot be enabled or verified; ordinary threads.send is not a safe substitute.";

test("a legacy or unrecognized ending is watched again, never 'changed at the last second'", () => {
  const watching = { state: "watching", sendAt: null, totalMs: null, checkIn: false, text: "Watching", detail: "I'll check the next reply", updatedAt: NOW, nudgeCount: 0 };
  assert.deepEqual(continuationStatus(input({ record: ending({ classification: null, action: "suppressed", reason: LEGACY_REASON }) })), watching);
  assert.deepEqual(continuationStatus(input({ record: ending({ classification: null, action: "suppressed", reason: "some future suppression reason" }) })), watching);
  assert.deepEqual(continuationStatus(input({ record: ending({ classification: "continue", action: "observed", reason: LEGACY_REASON }) })), watching);
  // A nudge recovery itself withheld or cancelled for an unrecognized reason still reads as last-second.
  assert.deepEqual(copy({ record: ending({ action: "suppressed", reason: "Continuation withheld: an unrecognized gate" }) }), ["Something changed at the last second", "No nudge sent"]);
  assert.deepEqual(copy({ record: ending({ action: "suppressed", reason: "Continuation cancelled: an unrecognized reason" }) }), ["Something changed at the last second", "No nudge sent"]);
});

test("no status copy mentions internals", () => {
  const all = [
    copy({ record: ending({ classification: null, action: "observed" }) }), copy({ detectorId: null }),
    copy({ record: ending({ action: "suppressed", reason: "Continuation candidate classified, but auto-continue is off for this thread" }) }),
  ];
  for (const text of all.map(pair => pair.join(" "))) assert.doesNotMatch(text, /jev|detector(?! in Nudger settings)|classif|cursor|admission|trial/i);
});

test("own, child, hidden, archived and unknown threads render nothing", () => {
  assert.equal(continuationStatus(input({ ownThread: true })).state, "hidden");
  for (const exclusion of ["child", "hidden", "orchestrator identity", "own slapper role", "role identities unavailable"]) {
    assert.equal(continuationStatus(input({ thread: inventory({ exclusion }), nudge: nudged() })).state, "hidden", exclusion);
  }
  assert.equal(continuationStatus(input({ thread: null })).state, "hidden");
  assert.equal(continuationStatus({ ...input(), recovery: null }).state, "hidden");
});
