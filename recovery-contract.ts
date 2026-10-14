import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Public history DTO, inferred without importing the SDK's internal type name. */
export type ThreadEventRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];

export const RECOVERY_NUDGE = "please continue";

export type RecoveryClassification = "continue" | "finished" | "blocker" | "permission" | "uncertainty";

export interface DetectorUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cost: { amount: number; currency: string } | null;
}

export interface FinalMessageJudgment {
  classification: RecoveryClassification;
  model: string;
  latencyMs: number;
  usage: DetectorUsage;
  confidence: number | null;
  probabilities: Partial<Record<RecoveryClassification, number>> | null;
  questions: Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }> | null;
}

export interface FinalMessageClassifier {
  readonly id: string;
  classify(finalAssistantMessage: string, options?: { signal?: AbortSignal }): Promise<FinalMessageJudgment>;
}

export type RecoveryAction = "observed" | "finished" | "reported" | "suppressed" | "nudged" | "discarded" | "error";

export interface RecoveryRecord {
  id: string;
  threadId: string;
  projectId: string;
  runId: string;
  messageId: string;
  messageRevision: number;
  observedAt: number;
  classification: RecoveryClassification | null;
  action: RecoveryAction;
  reason: string;
  detector: string | null;
  judgment: FinalMessageJudgment | null;
  // Decision log (absent on records kept from before it existed). Not part of the v1 history view.
  /** Stable id of the gate that decided `action`; `reason` is its human wording. */
  gate?: string;
  /** The judged final message, stored compressed beside the record until the record leaves the decision log. */
  text?: RecoveryTextRef;
  /** The nudge scheduled for this ending and what became of it. */
  nudge?: RecoveryNudgeDecision;
  /** What the thread did next; settled once, lazily. */
  outcome?: RecoveryOutcome;
  /** An operator's verdict on this decision. */
  label?: RecoveryLabel;
}

export interface RecoveryTextRef {
  chars: number;
  /** Stored (compressed) bytes, for the storage budget. */
  bytes: number;
  /** The message was longer than the stored cap. */
  truncated: boolean;
}

export interface RecoveryNudgeDecision {
  nudgeId: string;
  /** The exact text dispatched (or that would have been). */
  text: string;
  scheduledAt: number;
  sendAt: number;
  state: "pending" | "cancelled" | "sent" | "withheld";
  /** Stable id of the send-time gate that cancelled or withheld it; null while pending and once sent. */
  gate: string | null;
  reason: string | null;
}

/** What followed a decision within the outcome window: the thread's next ending, the operator's Stop or cancel, or nothing. */
export interface RecoveryOutcome {
  kind: "next-ending" | "stopped" | "cancelled" | "none";
  at: number;
  /** `next-ending`: the following ending's record, and its classification/action as they settle. */
  nextRecordId: string | null;
  classification: RecoveryClassification | null;
  action: RecoveryAction | null;
  /** `stopped`/`cancelled`: the internal reason. */
  reason: string | null;
}

export interface RecoveryLabel {
  label: "wrong";
  note: string | null;
  /** Operator-supplied attribution for the label. */
  by: string;
  at: number;
}

/** One decision as exported: the record with its judged text and every decision field explicit. */
export interface RecoveryDecision extends Omit<RecoveryRecord, "gate" | "text" | "nudge" | "outcome" | "label"> {
  gate: string | null;
  text: string | null;
  textTruncated: boolean;
  nudge: RecoveryNudgeDecision | null;
  outcome: RecoveryOutcome | null;
  label: RecoveryLabel | null;
}

export interface RecoveryDecisionPage {
  decisions: RecoveryDecision[];
  nextCursor: string | null;
}

export interface RecoveryBlocker {
  recordId: string;
  threadId: string;
  projectId: string;
  runId: string;
  messageId: string;
  messageRevision: number;
  kind: "blocker" | "permission" | "uncertainty";
  finalAssistantMessage: string;
  observedAt: number;
}

export interface RecoveryInventoryThread {
  id: string;
  projectId: string;
  title: string | null;
  status: string;
  hostId: string | null;
  visibility: string;
  parentThreadId: string | null;
  watched: boolean;
  exclusion: string | null;
}

export interface RecoveryInventoryProject {
  id: string;
  name: string;
}

export interface RecoveryStatus {
  /** Automatic continuation can act: unpaused with a detector selected (each thread can still be turned off). */
  enabled: boolean;
  /** Passive lifecycle/inventory observation is running, independently of dispatch. */
  observing: boolean;
  /** A selected detector can classify new live endings while observation is unpaused. */
  classifying: boolean;
  paused: boolean;
  detectorId: string | null;
  /** Conditions currently keeping classification (and so continuation) from running. */
  gates: string[];
  startedAt: number | null;
  lastObservedAt: number | null;
  threads: RecoveryInventoryThread[];
  projects: RecoveryInventoryProject[];
  watchedCount: number;
  error: string | null;
}

/** Recovery's live observation of a thread's current root run and its final assistant message. */
export interface RecoveryCursor {
  runId: string | null;
  messageId: string | null;
  messageRevision: number | null;
  knownStop: boolean;
  /** The thread started a workflow whose steps are still running (or only just finished); it must not be nudged. */
  waitingForWorkflow: boolean;
}

/** A thread waiting on its workflow: hidden step threads still running, or the settle window after the last one ended. */
export interface RecoveryWorkflowWait {
  running: number;
  /** When the wait ends with no step running; null while a step runs. */
  settlingUntil: number | null;
}

/** Recovery's current facts about one thread, for the per-thread continuation status. */
export interface RecoveryThreadState {
  /** Inventory entry with live `watched`; null when recovery does not list the thread (unknown, archived, deleted). */
  thread: RecoveryInventoryThread | null;
  /** Root run recovery last saw start on the thread; null when unknown (for example, an idle thread since startup). */
  currentRunId: string | null;
  /** The thread's most recently observed ending. */
  latestRecord: RecoveryRecord | null;
  classifying: boolean;
  paused: boolean;
  detectorId: string | null;
  /** The thread's workflow wait; null when it is not waiting on one. */
  workflow: RecoveryWorkflowWait | null;
  /** A `/compact` maintenance turn is running; the last real reply is checked after it. */
  compacting: boolean;
}

export interface RecoveryService {
  start(): Promise<void>;
  refresh(): Promise<RecoveryStatus>;
  setPaused(paused: boolean): Promise<RecoveryStatus>;
  configure(detector: FinalMessageClassifier | null): RecoveryStatus;
  status(): RecoveryStatus;
  /** Live cursor for an observed, eligible thread; null when the thread is not being observed. */
  cursor(threadId: string): RecoveryCursor | null;
  /** Cheap in-memory read of one thread's inventory entry and latest ending. */
  threadState(threadId: string): RecoveryThreadState;
  /** Public-current-state revalidation of a captured or retained obstacle: it must still be the thread's newest completed ending. */
  validateBlocker(blocker: RecoveryBlocker): Promise<boolean>;
  /**
   * A person started new work on the thread (admitted, human-initiated, no plugin submission):
   * an earlier manual Stop no longer suppresses that thread's later endings. Stops after `at` still apply.
   */
  rearm(threadId: string, at: number): void;
  /** The v1 history view: the records Headquarters and stats read (see historyRecordIds), without decision-log fields. */
  records(): RecoveryRecord[];
  /** One page of the decision log, oldest first: after `cursor`, observed at or after `since`. */
  decisions(request: { cursor: string | null; since?: number }): Promise<RecoveryDecisionPage>;
  /** Sets, or clears with null, the label on a retained decision; resolves the decision, or null when it is gone. */
  label(recordId: string, label: RecoveryLabel | null): Promise<RecoveryDecision | null>;
  /** Mirrors the thread's latest nudge onto the decision it was scheduled for (wired to continuation changes). */
  noteNudge(threadId: string): void;
  dispose(): Promise<void>;
}
