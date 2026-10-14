import type { Nudge } from "./continuation.js";
import { cancelledCopy, isNoCreditsError, LINE, type Line, suppressedCopy, withheldCopy, workflowLine } from "./continuation-copy.js";
import type { RecoveryInventoryThread, RecoveryRecord, RecoveryThreadState } from "./recovery-contract.js";

/**
 * `off`: the operator turned auto-continue off for the thread; the banner shows only its toggle.
 * `waiting`: like watching, but the reply is checked only after something finishes (its workflow, a compaction).
 */
export type ContinuationState = "hidden" | "off" | "watching" | "waiting" | "assessing" | "countdown" | "sent" | "skipped";

/** What the thread's composer banner shows about automatic continuation. */
export interface ContinuationStatus {
  state: ContinuationState;
  /** Server time the nudge sends at; set only for `countdown`. */
  sendAt: number | null;
  /** Full delay the countdown drains over; set only for `countdown`. */
  totalMs: number | null;
  /** Primary operator copy; null for `hidden`, `off` and `countdown` (whose line the banner derives from the remaining time). */
  text: string | null;
  /** Quieter secondary copy following `text`; null when there is none. */
  detail: string | null;
  /** Server time this status was computed; lets clients correct `sendAt` for clock skew. */
  updatedAt: number;
  /** Nudges this thread has received so far. */
  nudgeCount: number;
}

export interface ContinuationStatusInput {
  threadId: string;
  now: number;
  /** One of the Nudger's own registered conversations. */
  ownThread: boolean;
  /** Recovery's facts about the thread; null before the runtime has started. */
  recovery: RecoveryThreadState | null;
  /** The thread's per-thread toggle. */
  enabled: boolean;
  /** The thread's most recent nudge, in any state. */
  nudge: Nudge | null;
  /** Nudges this thread has received so far. */
  nudgeCount: number;
}

const STOP_EXCLUSION = "Observed manual Stop";
const HISTORY_EXCLUSION = "Live root-turn identity unavailable";

export function continuationStatus(input: ContinuationStatusInput): ContinuationStatus {
  const { recovery } = input;
  const thread = recovery?.thread ?? null;
  const quiet = { sendAt: null, totalMs: null, text: null, detail: null, updatedAt: input.now, nudgeCount: input.nudgeCount };
  // Exclusions other than Stop and unreadable history mean the thread is never a continuation candidate.
  if (input.ownThread || !recovery || !thread
    || (thread.exclusion !== null && !thread.exclusion.startsWith(STOP_EXCLUSION) && !thread.exclusion.startsWith(HISTORY_EXCLUSION))) {
    return { state: "hidden", ...quiet };
  }
  if (!input.enabled) return { state: "off", ...quiet };
  const nudge = input.nudge?.threadId === input.threadId ? input.nudge : null;
  if (nudge?.state === "pending") {
    return { state: "countdown", sendAt: nudge.sendAt, totalMs: nudge.sendAt - nudge.createdAt, text: null, detail: null, updatedAt: input.now, nudgeCount: input.nudgeCount };
  }
  const [state, { text, detail }] = outcome(recovery, thread, nudge);
  return { state, sendAt: null, totalMs: null, text, detail, updatedAt: input.now, nudgeCount: input.nudgeCount };
}

type Outcome = [state: Exclude<ContinuationState, "hidden" | "off" | "countdown">, line: Line];

function outcome(recovery: RecoveryThreadState, thread: RecoveryInventoryThread, nudge: Nudge | null): Outcome {
  if (recovery.paused) return ["skipped", LINE.paused];
  if (thread.exclusion?.startsWith(STOP_EXCLUSION)) return ["skipped", LINE.stopExclusion];
  if (thread.exclusion !== null) return ["skipped", LINE.notFollowable];
  if (recovery.detectorId === null) return ["skipped", LINE.noDetector];
  const latest = recovery.latestRecord;
  // A record from an earlier run than the one recovery last saw start says nothing about the latest ending.
  const record: RecoveryRecord | null = latest && (recovery.currentRunId === null || latest.runId === recovery.currentRunId) ? latest : null;
  if (recovery.compacting && recovery.classifying) return ["waiting", LINE.compacting];
  if (thread.watched || thread.status === "active") {
    if (!recovery.classifying) return ["skipped", LINE.notFollowable];
    // The run the sent nudge started: its classified ending is still the latest one recorded.
    const followsNudge = nudge?.state === "sent" && latest !== null && nudge.runId === latest.runId;
    return ["watching", followsNudge ? LINE.nudgedWatching : LINE.watchingRun];
  }
  if (recovery.workflow) return ["waiting", workflowLine(recovery.workflow.running)];
  if (!record) return ["watching", LINE.watchingNext];
  if (record.action === "observed" && record.classification === null) return ["assessing", LINE.reading];
  if (record.action === "error") return ["skipped", isNoCreditsError(record.reason) ? LINE.noCredits : LINE.readError];
  if (record.classification === "continue") {
    const forRecord = nudge && nudge.runId === record.runId && nudge.messageId === record.messageId && nudge.messageRevision === record.messageRevision ? nudge : null;
    if (forRecord?.state === "sent") return ["sent", LINE.nudged];
    if (forRecord?.state === "cancelled") return ["skipped", cancelledCopy(forRecord.cancelReason)];
    if (forRecord?.state === "withheld") return ["skipped", withheldCopy(forRecord.cancelReason)];
    // Classified 'continue' and handed to scheduling, which has not reported back yet.
    if (record.action === "nudged") return ["assessing", LINE.reading];
  }
  if (record.action === "suppressed") {
    const copy = suppressedCopy(record.reason);
    return [copy === LINE.watchingNext ? "watching" : "skipped", copy];
  }
  if (record.classification === "finished") return ["skipped", LINE.finished];
  if (record.classification === "blocker") return ["skipped", LINE.blocker];
  if (record.classification === "permission") return ["skipped", LINE.permission];
  if (record.classification === "uncertainty") return ["skipped", LINE.uncertainty];
  // An unrecognized or legacy ending says nothing the operator can act on; the thread is watched again.
  return ["watching", LINE.watchingNext];
}
