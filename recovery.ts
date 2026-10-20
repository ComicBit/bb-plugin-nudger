import { z } from "zod";
import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { CHECK_IN_MS, NUDGE_STREAK_LIMIT, SCHEDULED_REASON, type Continuation } from "./continuation.js";
import { CANCEL_REASON, HELD_REASON, isKeyRejectedError, isNoCreditsError, NUDGE_STREAK_REASON, WITHHELD_REASON } from "./continuation-copy.js";
import { RECOVERY_NUDGE, type FinalMessageClassifier, type RecoveryBlocker, type RecoveryCursor, type RecoveryInventoryProject, type RecoveryInventoryThread, type RecoveryNudgeDecision, type RecoveryRecord, type RecoveryService, type RecoveryStatus, type RecoveryThreadState, type RecoveryWait, type RecoveryWaitKind, type ThreadEventRow } from "./recovery-contract.js";
import { createKvWriter } from "./kv-writer.js";
import { SETTLE_MS, threadRunning, workflowOwner } from "./running-work.js";
import { LEGACY_DATA_PREFIX, retainedKeys, retainedValue } from "./migration-storage.js";
import { DECISION_LIMITS, decisionCursor, decisionsAfter, decodeText, encodeText, GATE, historyRecord, historyRecordIds, noneOutcome, nudgeGate, operatorCancelled, OUTCOME_WINDOW_MS, planRetention, RECORD_KEY, TEXT_KEY, toDecision } from "./decision-log.js";
import { jevBlockerFacts, jevCheckIn } from "./detectors.js";
import { PAGE_BYTES } from "./publication.js";
type ThreadResponse = PluginThreadEventPayloads["thread.idle"]["thread"];

export interface RecoveryObservation {
  threadId: string;
  runId: string | null;
  active: boolean;
  eligible: boolean;
  suppressedByStop: boolean;
  finalMessage: { id: string; revision: number; text: string } | null;
}

/** Local observation deduplication, not an execution admission fence. */
export class RecoveryEndTracker {
  private readonly watched = new Map<string, string>();
  private readonly ended = new Set<string>();
  reconcile(observations: readonly RecoveryObservation[]): void {
    this.watched.clear();
    for (const observation of observations) this.observe({ ...observation, finalMessage: null });
  }
  observe(observation: RecoveryObservation): RecoveryObservation | null {
    if (!observation.eligible || observation.suppressedByStop || !observation.runId) {
      this.watched.delete(observation.threadId);
      return null;
    }
    if (observation.active) {
      this.watched.set(observation.threadId, observation.runId);
      return null;
    }
    if (this.watched.get(observation.threadId) !== observation.runId) return null;
    this.watched.delete(observation.threadId);
    const key = JSON.stringify([observation.threadId, observation.runId]);
    if (this.ended.has(key)) return null;
    this.ended.add(key);
    return observation.finalMessage?.text.trim() ? observation : null;
  }
  forget(threadId: string): void { this.watched.delete(threadId); }
  isWatching(threadId: string, runId?: string): boolean {
    const current = this.watched.get(threadId);
    return runId === undefined ? current !== undefined : current === runId;
  }
}

export interface RecoveryServiceOptions {
  bb: BbPluginApi;
  /** Optional control conversations from public plugin discovery; an absent peer returns an empty list. */
  controlThreadIds(): Promise<readonly string[]>;
  detector: FinalMessageClassifier | null;
  reportBlocker(blocker: RecoveryBlocker): Promise<void>;
  onChange?(): void;
  /** Automatic continuation: classified 'continue' endings of threads it has on are scheduled; others are recorded as suppressed. */
  continuation?: Pick<Continuation, "enabled" | "schedule" | "cancel" | "latest" | "streak">;
}

const classificationSchema = z.enum(["continue", "finished", "blocker", "permission", "uncertainty"]);
const actionSchema = z.enum(["observed", "finished", "reported", "suppressed", "nudged", "discarded", "error"]);
const recordSchema: z.ZodType<RecoveryRecord> = z.object({
  id: z.string(), threadId: z.string(), projectId: z.string(), runId: z.string(), messageId: z.string(),
  messageRevision: z.number().int().nonnegative(), observedAt: z.number(),
  classification: classificationSchema.nullable(), action: actionSchema,
  reason: z.string(), detector: z.string().nullable(),
  judgment: z.object({
    classification: classificationSchema, model: z.string(), latencyMs: z.number(),
    usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), cost: z.object({ amount: z.number(), currency: z.string() }).nullable() }),
    confidence: z.number().nullable(), probabilities: z.record(z.string(), z.number()).nullable(),
    questions: z.record(z.string(), z.object({ choice: z.string(), confidence: z.number(), probabilities: z.record(z.string(), z.number()) })).nullable(),
  }).nullable(),
  gate: z.string().optional(),
  text: z.object({ chars: z.number(), bytes: z.number(), truncated: z.boolean() }).optional(),
  nudge: z.object({ nudgeId: z.string(), text: z.string(), scheduledAt: z.number(), sendAt: z.number(), state: z.enum(["pending", "cancelled", "sent", "withheld"]),
    gate: z.string().nullable(), reason: z.string().nullable() }).optional(),
  outcome: z.object({ kind: z.enum(["next-ending", "stopped", "cancelled", "none"]), at: z.number(), nextRecordId: z.string().nullable(),
    classification: classificationSchema.nullable(), action: actionSchema.nullable(), reason: z.string().nullable() }).optional(),
  label: z.object({ label: z.literal("wrong"), note: z.string().nullable(), by: z.string(), at: z.number() }).optional(),
});
const historyTypes = ["turn/started", "turn/completed", "item/completed", "system/thread/interrupted", "thread/context/cleared", "thread/compacted",
  "client/turn/requested", "client/turn/rejected", "turn/input/accepted"] as const;
interface Cursor {
  seq: number;
  runId: string | null;
  finalMessage: RecoveryObservation["finalMessage"];
  knownStop: boolean;
  /** `/compact` requests not yet matched to the root turn each one starts. */
  maintenanceRequests: string[];
  /** The running maintenance turn: it never becomes `runId`, so the run's final message stays the ending. */
  maintenance: { turnId: string; requestId: string } | null;
}
type ObservedThread = Pick<ThreadResponse, "id" | "projectId" | "title" | "titleFallback" | "status" | "runtime" | "visibility" | "parentThreadId" | "originPluginId" | "lifecycleOwnerThreadId" | "archivedAt" | "deletedAt" | "updatedAt">;
interface ClassificationJob {
  record: RecoveryRecord;
  detector: FinalMessageClassifier;
  controller: AbortController;
}
interface ClassificationWindow {
  epoch: number;
  paused: boolean;
}

/** Canonical state and its runtime projection can disagree; neither is a root-run identity. */
function hasActiveExecutionSignal(thread: ObservedThread): boolean {
  return thread.status === "active" || thread.runtime.displayStatus === "active";
}

const PENDING_REASON = "Live public root ending observed; final-message-only classification pending";
const HELD: Record<string, true> = { [HELD_REASON.workflow]: true, [HELD_REASON.subthread]: true, [HELD_REASON.maintenance]: true };
const HELD_GATE: Record<string, string> = { [HELD_REASON.workflow]: GATE.workflow, [HELD_REASON.subthread]: GATE.subthread, [HELD_REASON.maintenance]: GATE.maintenance };
// A nudge withheld at send time for work the thread waits on is that ending's hold.
const WAITED: Record<string, true> = { [WITHHELD_REASON.workflow]: true, [WITHHELD_REASON.subthread]: true };
const PRUNE_INTERVAL_MS = 3_600_000;
// Bounds the walk up a parent chain, so malformed nesting cannot spin.
const MAX_NESTING = 32;

export function createRecoveryService(options: RecoveryServiceOptions): RecoveryService {
  const { bb } = options;
  const tracker = new RecoveryEndTracker();
  const inventory = new Map<string, RecoveryInventoryThread>();
  const cursors = new Map<string, Cursor>();
  const ownedThreads = new Set<string>();
  // A manual Stop suppresses recovery until a later admitted, human-initiated dispatch re-arms the thread.
  // History rows cannot tell a person's message from a plugin's, so re-arming is decided live at admission.
  const stoppedThreads = new Set<string>();
  const rearmedAt = new Map<string, number>();
  const latestThreads = new Map<string, { thread: ObservedThread; version: number }>();
  const liveBaselines = new Map<string, { thread: ObservedThread; rows: Promise<ThreadEventRow[] | null>; window: ClassificationWindow }>();
  const jobs = new Map<string, ClassificationJob>();
  const records: RecoveryRecord[] = [];
  const recordsById = new Map<string, RecoveryRecord>();
  // Records are mutated in place, so the latest reference per thread stays current.
  const latestRecords = new Map<string, RecoveryRecord>();
  // Each record whose outcome is a next ending, by that next ending's id: its classification/action settle later.
  const predecessors = new Map<string, RecoveryRecord>();
  // Stored bytes per record (its JSON plus its text), for the decision log's hard cap.
  const storedBytes = new Map<string, number>();
  // Only a successful judgment from this runtime and the same detector instance can survive a hold.
  let successfulJudgments = new WeakMap<RecoveryRecord, NonNullable<RecoveryRecord["judgment"]>>();
  // Work each root waits on (its running workflow steps and subthreads, by kind), each running
  // thread's root, and when a root with nothing left running stops waiting, and on what it waited.
  const runningWork = new Map<string, Map<string, RecoveryWaitKind>>();
  const workRoots = new Map<string, string>();
  const settling = new Map<string, { until: number; kind: RecoveryWaitKind }>();
  const settleTimers = new Map<string, NodeJS.Timeout>();
  let projects: RecoveryInventoryProject[] = [];
  let detector = options.detector;
  let identitiesKnown = false;
  let paused = false;
  let classificationEpoch = 0;
  let initialized = false;
  let disposed = false;
  let listenersBound = false;
  let startedAt: number | null = null;
  let lastObservedAt: number | null = null;
  let error: string | null = null;
  let starting: Promise<void> | null = null;
  let mutations: Promise<unknown> = Promise.resolve();
  let eventVersion = 0;
  let reconciliationTimer: NodeJS.Timeout | undefined;
  let prunedAt = -Infinity;
  const kv = createKvWriter(bb.storage.kv);

  function gates(): string[] {
    return [...(!identitiesKnown ? ["owned-role-identities-unavailable"] : []), ...(!detector ? ["detector-not-selected"] : [])];
  }
  function classifying(): boolean {
    return initialized && !disposed && identitiesKnown && !paused && detector !== null;
  }
  function status(): RecoveryStatus {
    const observing = initialized && !disposed;
    return { enabled: !paused && detector !== null, observing, classifying: classifying(), paused, detectorId: detector?.id ?? null, gates: gates(), startedAt, lastObservedAt,
      threads: [...inventory.values()].map(thread => ({ ...thread, watched: tracker.isWatching(thread.id) })),
      projects, watchedCount: [...inventory.keys()].filter(id => tracker.isWatching(id)).length, error };
  }
  function addRecord(record: RecoveryRecord): void {
    records.push(record); recordsById.set(record.id, record);
    storedBytes.set(record.id, Buffer.byteLength(JSON.stringify(record)) + (record.text?.bytes ?? 0));
    const latest = latestRecords.get(record.threadId);
    if (!latest || record.observedAt >= latest.observedAt) latestRecords.set(record.threadId, record);
  }
  /** Records what decided the record's action, and why. */
  function decide(record: RecoveryRecord, action: RecoveryRecord["action"], gate: string, reason: string): void {
    record.action = action; record.gate = gate; record.reason = reason;
  }
  function changed(): void {
    if (disposed) return;
    options.onChange?.();
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutations.catch(() => undefined).then(operation);
    mutations = next;
    return next;
  }
  /** Writes the record (skipped when storage already holds it as-is) and settles its predecessor's next-ending outcome. */
  async function persist(record: RecoveryRecord): Promise<void> {
    if (recordsById.get(record.id) === record) storedBytes.set(record.id, Buffer.byteLength(JSON.stringify(record)) + (record.text?.bytes ?? 0));
    await kv.set(`${RECORD_KEY}${record.id}`, record);
    const previous = predecessors.get(record.id);
    const outcome = previous?.outcome;
    if (!previous || outcome?.nextRecordId !== record.id || (outcome.classification === record.classification && outcome.action === record.action)) return;
    outcome.classification = record.classification; outcome.action = record.action;
    await persist(previous);
  }
  /**
   * Sets the latest decision's outcome when nothing settled it yet and `at` falls inside its outcome window. Records
   * from before the decision log (no gate) get none: nothing was watching what followed them.
   */
  function settleOutcome(threadId: string, kind: "stopped" | "cancelled", at: number, reason: string): void {
    const record = latestRecords.get(threadId);
    if (record?.gate === undefined || record.outcome || at < record.observedAt || at - record.observedAt > OUTCOME_WINDOW_MS) return;
    record.outcome = { kind, at, nextRecordId: null, classification: null, action: null, reason };
    void serial(() => persist(record)).catch(caught => bb.log.warn(`Recovery outcome persistence failed: ${String(caught)}`));
  }
  /** Mirrors the thread's latest nudge onto the decision it was scheduled for; the operator cancelling it is that decision's outcome. */
  function noteNudge(threadId: string): void {
    const nudge = options.continuation?.latest(threadId);
    const record = latestRecords.get(threadId);
    if (disposed || !nudge || !record || nudge.runId !== record.runId || nudge.messageId !== record.messageId || nudge.messageRevision !== record.messageRevision) return;
    const next: RecoveryNudgeDecision = { nudgeId: nudge.nudgeId, text: RECOVERY_NUDGE, scheduledAt: nudge.createdAt, sendAt: nudge.sendAt,
      state: nudge.state, gate: nudgeGate(nudge.state, nudge.cancelReason), reason: nudge.cancelReason };
    if (JSON.stringify(next) === JSON.stringify(record.nudge)) return;
    record.nudge = next;
    if (nudge.state === "cancelled" && operatorCancelled(nudge.cancelReason)) settleOutcome(threadId, "cancelled", Date.now(), nudge.cancelReason!);
    void serial(() => persist(record)).catch(caught => bb.log.warn(`Recovery nudge persistence failed: ${String(caught)}`));
  }
  /** Decisions whose outcome window passed with nothing observed settle as "none"; runs inside `serial`. */
  async function settleExpiredOutcomes(now: number): Promise<void> {
    for (const record of records) {
      if (record.gate === undefined || record.outcome || now - record.observedAt < OUTCOME_WINDOW_MS) continue;
      record.outcome = noneOutcome(record);
      await persist(record);
    }
  }
  /**
   * Drops what the decision log and the v1 history view no longer need (at most hourly, or at once over a hard cap);
   * runs inside `serial`.
   */
  async function pruneRecords(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - prunedAt < PRUNE_INTERVAL_MS) return;
    prunedAt = now;
    try {
      await settleExpiredOutcomes(now);
      const { drop, dropText } = planRetention(records, record => storedBytes.get(record.id) ?? 0, now);
      if (!drop.size && !dropText.size) return;
      const dropped = records.filter(record => drop.has(record.id));
      records.splice(0, records.length, ...records.filter(record => !drop.has(record.id)));
      for (const record of dropped) {
        recordsById.delete(record.id); storedBytes.delete(record.id); predecessors.delete(record.id);
        if (latestRecords.get(record.threadId) === record) latestRecords.delete(record.threadId);
      }
      for (const [nextId, previous] of predecessors) if (drop.has(previous.id)) predecessors.delete(nextId);
      for (const record of dropped) {
        await kv.delete(`${RECORD_KEY}${record.id}`);
        if (record.text) await bb.storage.kv.delete(`${TEXT_KEY}${record.id}`);
      }
      for (const id of dropText) {
        const record = recordsById.get(id)!;
        delete record.text;
        await persist(record);
        await bb.storage.kv.delete(`${TEXT_KEY}${id}`);
      }
    } catch (caught) { bb.log.warn(`Recovery record pruning deferred: ${String(caught)}`); }
  }
  /**
   * Cancels in-flight classification, recording `gate`/`reason` on its ending. Anything that cancels it,
   * other than a new hold, also ends a held ending's wait.
   */
  function cancelClassifications(gate: string, reason: string, threadId?: string): void {
    const canceled: RecoveryRecord[] = [];
    for (const [id, job] of jobs) {
      if (threadId !== undefined && job.record.threadId !== threadId) continue;
      job.controller.abort();
      jobs.delete(id);
      if (job.record.action !== "observed") continue;
      decide(job.record, "suppressed", gate, reason);
      canceled.push(job.record);
    }
    if (HELD[reason] !== true) {
      for (const id of threadId === undefined ? [...latestRecords.keys()] : [threadId]) {
        const held = heldEnding(id);
        if (!held) continue;
        decide(held, "suppressed", gate, reason);
        canceled.push(held);
      }
    }
    if (canceled.length) {
      void serial(async () => { for (const record of canceled) await persist(record); }).catch(caught => bb.log.warn(`Recovery cancellation persistence failed: ${String(caught)}`));
      changed();
    }
  }
  /** A job that found its own ending stale stops; other jobs and holds on the thread are not its to cancel. */
  function abandon(job: ClassificationJob, gate: string, reason: string): void {
    job.controller.abort();
    if (jobs.get(job.record.id) !== job) return;
    jobs.delete(job.record.id);
    if (job.record.action !== "observed") return;
    decide(job.record, "suppressed", gate, reason);
    void serial(() => persist(job.record)).catch(caught => bb.log.warn(`Recovery cancellation persistence failed: ${String(caught)}`));
    changed();
  }
  function workWait(threadId: string): RecoveryWait | null {
    const work = runningWork.get(threadId);
    if (work) {
      let steps = 0;
      for (const kind of work.values()) if (kind === "workflow") steps++;
      return { kind: steps ? "workflow" : "subthread", running: steps || work.size, settlingUntil: null };
    }
    const settle = settling.get(threadId);
    return settle !== undefined && settle.until > Date.now() ? { kind: settle.kind, running: 0, settlingUntil: settle.until } : null;
  }
  /** What keeps the thread's latest ending from being judged now: a compaction, its workflow or its subthreads. */
  function holdReason(threadId: string): string | null {
    if (cursors.get(threadId)?.maintenance) return HELD_REASON.maintenance;
    const wait = workWait(threadId);
    return wait ? HELD_REASON[wait.kind] : null;
  }
  /** The thread's latest ending when it waits to be judged: held, or its nudge withheld for the work it waits on. */
  function heldEnding(threadId: string): RecoveryRecord | null {
    const record = latestRecords.get(threadId);
    if (!record) return null;
    if (record.action === "suppressed" && HELD[record.reason] === true) return record;
    const nudge = record.action === "nudged" ? options.continuation?.latest(threadId) : null;
    return nudge?.state === "withheld" && WAITED[nudge.cancelReason ?? ""] === true
      && nudge.runId === record.runId && nudge.messageId === record.messageId && nudge.messageRevision === record.messageRevision ? record : null;
  }
  /** Re-admits an unchanged held ending with fresh lifecycle checks, reusing its successful judgment when possible. */
  async function release(threadId: string, ready?: Promise<void>): Promise<void> {
    const record = heldEnding(threadId);
    const cursor = cursors.get(threadId);
    const thread = latestThreads.get(threadId)?.thread;
    const selected = detector;
    if (!record || !cursor?.finalMessage || !thread || !selected || !classifying() || holdReason(threadId) !== null || cursor.knownStop
      || hasActiveExecutionSignal(thread) || inventory.get(threadId)?.exclusion !== null || cursor.runId !== record.runId
      || cursor.finalMessage.id !== record.messageId || cursor.finalMessage.revision !== record.messageRevision) return;
    const previousJudgment = successfulJudgments.get(record) ?? null;
    decide(record, "observed", GATE.pending, PENDING_REASON);
    record.classification = null;
    record.judgment = null;
    record.detector = selected.id;
    classifyEnding(record, observation(threadId, cursor, false), selected, ready, previousJudgment);
    await persist(record);
    changed();
  }
  /** A maintenance turn started: the previous ending's classification and nudge wait until it finishes. */
  function holdForMaintenance(threadId: string): void {
    cancelClassifications(GATE.maintenance, HELD_REASON.maintenance, threadId);
    options.continuation?.cancel(threadId, CANCEL_REASON.maintenance);
    const record = latestRecords.get(threadId);
    const nudge = options.continuation?.latest(threadId);
    if (record?.action !== "nudged" || nudge?.state !== "cancelled" || nudge.cancelReason !== CANCEL_REASON.maintenance
      || nudge.runId !== record.runId || nudge.messageId !== record.messageId || nudge.messageRevision !== record.messageRevision) return;
    decide(record, "suppressed", GATE.maintenance, HELD_REASON.maintenance);
    void serial(() => persist(record)).catch(caught => bb.log.warn(`Recovery hold persistence failed: ${String(caught)}`));
    changed();
  }
  /** The root at the top of the chain a thread's work reports back up, as far as observed threads tell. */
  function rootOf(threadId: string): string {
    let root = threadId;
    for (let depth = 0; depth < MAX_NESTING; depth++) {
      const thread = latestThreads.get(root)?.thread;
      const up = thread ? workflowOwner(thread) ?? thread.parentThreadId : null;
      if (up === null) break;
      root = up;
    }
    return root;
  }
  /**
   * Workflow steps and subthreads are never judged themselves; their lifecycle is what their root waits on.
   * A root learned late (its chain observed after the running thread) moves the work there on the next observation.
   */
  function noteRunningWork(thread: ObservedThread): void {
    const owner = workflowOwner(thread);
    const reportsTo = owner ?? thread.parentThreadId;
    const runningFor = reportsTo !== null && threadRunning(thread) ? rootOf(reportsTo) : null;
    if (workRoots.has(thread.id) && workRoots.get(thread.id) !== runningFor) workStopped(thread.id);
    if (runningFor === null || workRoots.has(thread.id)) return;
    workRoots.set(thread.id, runningFor);
    runningWork.set(runningFor, (runningWork.get(runningFor) ?? new Map()).set(thread.id, owner !== null ? "workflow" : "subthread"));
    stopSettling(runningFor);
  }
  function stopSettling(root: string): void {
    settling.delete(root);
    clearTimeout(settleTimers.get(root));
    settleTimers.delete(root);
  }
  function workStopped(threadId: string): void {
    const root = workRoots.get(threadId);
    if (root === undefined) return;
    workRoots.delete(threadId);
    const work = runningWork.get(root)!;
    const kind = work.get(threadId)!;
    work.delete(threadId);
    if (work.size) return;
    runningWork.delete(root);
    const until = Date.now() + SETTLE_MS;
    settling.set(root, { until, kind });
    armSettle(root, until);
  }
  function armSettle(root: string, until: number): void {
    clearTimeout(settleTimers.get(root));
    const timer = setTimeout(() => {
      settleTimers.delete(root);
      void serial(async () => {
        if (disposed || runningWork.has(root) || settling.get(root)?.until !== until) return;
        if (until > Date.now()) { armSettle(root, until); return; }
        settling.delete(root);
        await release(root);
        changed();
      }).catch(caught => { if (!disposed) bb.log.warn(`Recovery wait release deferred: ${String(caught)}`); });
    }, Math.max(0, until - Date.now()));
    timer.unref?.();
    settleTimers.set(root, timer);
  }
  function remember(thread: ObservedThread, event = false): ObservedThread {
    const previous = latestThreads.get(thread.id);
    const version = event ? ++eventVersion : previous?.version ?? 0;
    // Events carry the committed public DTO. Retain fresher event facts when a
    // paginated list (or a delayed announcement) returns an older row.
    const keepPrevious = previous && (previous.thread.updatedAt > thread.updatedAt
      || (!event && previous.version > 0 && previous.thread.updatedAt === thread.updatedAt));
    const current = keepPrevious ? previous.thread : { ...thread };
    latestThreads.set(thread.id, { thread: current, version });
    return current;
  }
  function freshest(thread: ObservedThread): ObservedThread {
    const latest = latestThreads.get(thread.id)?.thread;
    return latest && latest.updatedAt >= thread.updatedAt ? latest : thread;
  }
  async function exclusion(thread: ObservedThread): Promise<string | null> {
    if (thread.deletedAt !== null) return "deleted";
    if (thread.archivedAt !== null) return "archived";
    if (thread.visibility !== "visible") return "hidden";
    if (thread.parentThreadId !== null) return "child";
    if (!identitiesKnown) return "role identities unavailable";
    if (ownedThreads.has(thread.id) || thread.originPluginId === bb.pluginId) return "orchestrator identity";
    try {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
      if (metadata.role === "orchestrator" || metadata.role === "slapper" || metadata.role === "control") return `own ${metadata.role} role`;
    } catch { return "role metadata unreadable"; }
    return null;
  }
  function observation(threadId: string, cursor: Cursor, active: boolean): RecoveryObservation {
    return { threadId, runId: cursor.runId, active, eligible: true, suppressedByStop: cursor.knownStop, finalMessage: cursor.finalMessage };
  }
  function startRun(cursor: Cursor, threadId: string, turnId: string): void {
    if (cursor.runId !== turnId) cancelClassifications(GATE.superseded, "A later root execution superseded the classified ending", threadId);
    // The settle bridged the gap until the work's report (or anyone) reached the root; this run's ending is judged on its own.
    stopSettling(threadId);
    cursor.runId = turnId;
    cursor.finalMessage = null;
  }
  /** Applies one history row; says whether it started a root run or reset the cursor. */
  function apply(cursor: Cursor, row: ThreadEventRow): "run" | "reset" | null {
    cursor.seq = Math.max(cursor.seq, row.seq);
    if (row.type === "system/thread/interrupted" && row.data.reason === "manual-stop" && row.createdAt > (rearmedAt.get(row.threadId) ?? -Infinity)) {
      cursor.knownStop = true;
      options.continuation?.cancel(row.threadId, CANCEL_REASON.stop);
      if (!stoppedThreads.has(row.threadId)) {
        stoppedThreads.add(row.threadId);
        void serial(() => bb.storage.kv.set(`recovery.stopped.${row.threadId}`, true))
          .catch(caught => bb.log.warn(`Recovery Stop persistence failed: ${String(caught)}`));
      }
      settleOutcome(row.threadId, "stopped", row.createdAt, CANCEL_REASON.stop);
      cancelClassifications(GATE.stop, "Observed manual Stop; waits for your next message to re-arm", row.threadId);
    }
    if (row.type === "client/turn/requested") {
      // A `/compact` command, by its mention rather than its text, asks for a maintenance turn instead of new work.
      if (row.data.input.some(part => part.type === "text" && part.mentions.some(mention => mention.resource.kind === "command" && mention.resource.name === "compact"))) {
        cursor.maintenanceRequests.push(row.data.requestId);
      }
      return null;
    }
    if (row.type === "client/turn/rejected") {
      cursor.maintenanceRequests = cursor.maintenanceRequests.filter(id => id !== row.data.requestId);
      return null;
    }
    // Compacting inside the current run (or a maintenance turn) keeps the run and its final message.
    const ownCompaction = row.type === "thread/compacted" && row.scope.kind === "turn"
      && (row.scope.turnId === cursor.runId || row.scope.turnId === cursor.maintenance?.turnId);
    if (row.type === "thread/context/cleared" || (row.type === "thread/compacted" && !ownCompaction)) {
      cursor.runId = null;
      cursor.finalMessage = null;
      cancelClassifications(GATE.historyReset, "Root history was cleared or compacted before classification admission", row.threadId);
      return "reset";
    }
    if (row.scope.kind !== "turn") return null;
    const turnId = row.scope.turnId;
    if (row.type === "turn/started" && !row.data.parentToolCallId) {
      if (cursor.maintenance?.turnId === turnId) return null;
      const requestId = cursor.maintenanceRequests.shift();
      if (requestId !== undefined) {
        cursor.maintenance = { turnId, requestId };
        holdForMaintenance(row.threadId);
        return null;
      }
      cursor.maintenance = null;
      startRun(cursor, row.threadId, turnId);
      return "run";
    }
    if (row.type === "turn/input/accepted" && cursor.maintenance?.turnId === turnId && row.data.clientRequestId !== cursor.maintenance.requestId) {
      // Another request started this turn: it is a real run, and the compaction is still to come.
      cursor.maintenanceRequests.unshift(cursor.maintenance.requestId);
      cursor.maintenance = null;
      startRun(cursor, row.threadId, turnId);
      return "run";
    }
    if (row.type === "turn/completed" && cursor.maintenance?.turnId === turnId) cursor.maintenance = null;
    if (row.type === "item/completed" && turnId === cursor.runId && row.data.item.type === "agentMessage" && !row.data.item.parentToolCallId) {
      // Sequence identifies the observed persisted item version; it is not a native immutable revision fence.
      cursor.finalMessage = { id: row.data.item.id, revision: row.seq, text: row.data.item.text };
    }
    return null;
  }
  function currentEnding(job: ClassificationJob): boolean {
    const cursor = cursors.get(job.record.threadId);
    return !disposed && initialized && !paused && detector === job.detector && !job.controller.signal.aborted
      && inventory.get(job.record.threadId)?.exclusion === null && cursor?.knownStop === false
      && cursor.runId === job.record.runId && cursor.finalMessage?.id === job.record.messageId
      && cursor.finalMessage.revision === job.record.messageRevision;
  }
  function classifyEnding(record: RecoveryRecord, ending: RecoveryObservation, selected: FinalMessageClassifier, ready?: Promise<void>, previousJudgment: RecoveryRecord["judgment"] = null): void {
    const job: ClassificationJob = { record, detector: selected, controller: new AbortController() };
    jobs.set(record.id, job);
    // Detector and report latency are outside the inventory/lifecycle mutation lane.
    void (async () => {
      try {
        // Within an observed batch, later rows apply first: an ending they already replaced never reaches the detector.
        await ready;
        if (job.controller.signal.aborted || disposed) return;
        const controlsBeforeCall = await options.controlThreadIds();
        if (controlsBeforeCall.includes(record.threadId)) { abandon(job, GATE.control, "Thread became a control conversation before classification"); return; }
        if (job.controller.signal.aborted || disposed) return;
        const judgment = previousJudgment ?? await selected.classify(ending.finalMessage!.text, { signal: job.controller.signal });
        if (job.controller.signal.aborted || disposed) return;
        const controlsBeforeRouting = await options.controlThreadIds();
        if (controlsBeforeRouting.includes(record.threadId)) { abandon(job, GATE.control, "Thread became a control conversation before routing"); return; }
        if (job.controller.signal.aborted || disposed) return;
        let validatedVersion = 0;
        const blocker = await serial(async (): Promise<RecoveryBlocker | null> => {
          if (!currentEnding(job)) {
            abandon(job, GATE.stale, "The observed root ending is no longer current for classification routing");
            return null;
          }
          const thread = remember(await bb.sdk.threads.get({ threadId: record.threadId }));
          validatedVersion = latestThreads.get(thread.id)?.version ?? 0;
          await observe(thread);
          if (!currentEnding(job) || (latestThreads.get(thread.id)?.version ?? 0) !== validatedVersion) {
            abandon(job, GATE.stale, "Lifecycle or final-message evidence changed before classification routing");
            return null;
          }
          const nextRecord: RecoveryRecord = { ...record, classification: judgment.classification, judgment };
          const checkIn = jevCheckIn(judgment);
          const streak = options.continuation?.streak(record.threadId) ?? 0;
          if (judgment.classification === "continue" && options.continuation?.enabled(record.threadId)) {
            // Release after a hold may reuse this judgment, but admission and the nudge are always fresh.
            const held = holdReason(record.threadId);
            if (held) decide(nextRecord, "suppressed", HELD_GATE[held]!, held);
            else if (streak >= NUDGE_STREAK_LIMIT) decide(nextRecord, "suppressed", GATE.nudgeStreak, NUDGE_STREAK_REASON);
            else decide(nextRecord, "nudged", checkIn ? GATE.checkIn : GATE.nudge, SCHEDULED_REASON);
          } else if (judgment.classification === "continue") {
            decide(nextRecord, "suppressed", GATE.autoContinueOff, "Continuation candidate classified, but auto-continue is off for this thread");
          } else if (judgment.classification === "finished") {
            decide(nextRecord, "finished", GATE.finished, "Selected detector classified the same live root final assistant message as finished; no continuation dispatched");
          } else {
            decide(nextRecord, nextRecord.action, GATE.obstacle, "Live final-message obstacle classified; reporting is not authorization or continuation admission");
          }
          await persist(nextRecord);
          if (!currentEnding(job) || (latestThreads.get(thread.id)?.version ?? 0) !== validatedVersion) {
            abandon(job, GATE.stale, "Classification result canceled while it was being persisted");
            return null;
          }
          Object.assign(record, nextRecord);
          successfulJudgments.set(record, judgment);
          changed();
          if (record.action === "nudged") {
            const nudge = await options.continuation!.schedule(record, checkIn ? CHECK_IN_MS * 2 ** streak : undefined);
            noteNudge(record.threadId);
            if (nudge.state === "cancelled" || nudge.state === "withheld") {
              decide(record, "suppressed", nudgeGate(nudge.state, nudge.cancelReason)!, `Continuation ${nudge.state}: ${nudge.cancelReason ?? "no reason recorded"}`);
              await persist(record);
              changed();
            }
            return null;
          }
          if (judgment.classification === "continue" || judgment.classification === "finished") return null;
          return { recordId: record.id, threadId: record.threadId, projectId: record.projectId, runId: record.runId,
            messageId: record.messageId, messageRevision: record.messageRevision, kind: judgment.classification,
            finalAssistantMessage: ending.finalMessage!.text, observedAt: record.observedAt, ...jevBlockerFacts(judgment.questions) };
        });
        if (!blocker) return;
        // Pause/configuration/Stop/disposal can happen while persistence is awaited.
        if (!currentEnding(job) || (latestThreads.get(record.threadId)?.version ?? 0) !== validatedVersion) {
          abandon(job, GATE.stale, "Classification routing canceled by newer lifecycle evidence");
          return;
        }
        await options.reportBlocker(blocker);
        await serial(async () => {
          if (disposed || job.controller.signal.aborted) return;
          decide(record, "reported", GATE.reported, "Live final-message obstacle published by Nudger; no project work or continuation authorized");
          await persist(record);
          changed();
        });
      } catch (caught) {
        if (disposed || job.controller.signal.aborted) return;
        await serial(async () => {
          if (disposed || job.controller.signal.aborted) return;
          const reason = `Final-message classification/reporting failed: ${caught instanceof Error ? caught.message : String(caught)}`;
          decide(record, "error", isNoCreditsError(reason) ? GATE.noCredits : isKeyRejectedError(reason) ? GATE.keyRejected : GATE.detectorError, reason);
          await persist(record);
          changed();
        });
      } finally {
        if (jobs.get(record.id) === job) jobs.delete(record.id);
      }
    })().catch(caught => { if (!disposed) bb.log.warn(`Recovery classification persistence failed: ${String(caught)}`); });
  }
  async function recordEnding(thread: ObservedThread, ending: RecoveryObservation, window: ClassificationWindow, ready?: Promise<void>): Promise<void> {
    if (!ending.runId || !ending.finalMessage) return;
    const id = JSON.stringify([thread.id, ending.runId]);
    if (recordsById.has(id)) return;
    const selected = detector;
    const canClassify = (initialized || starting !== null) && !disposed && identitiesKnown && !paused
      && !window.paused && window.epoch === classificationEpoch && selected !== null;
    // A thread waiting on its workflow or subthreads keeps its ending unjudged until the wait ends.
    const held = canClassify ? holdReason(thread.id) : null;
    const unclassifiedGate = !selected ? GATE.noDetector : paused || window.paused ? GATE.paused : !identitiesKnown ? GATE.identities : GATE.policyChanged;
    const { value: text, ref } = encodeText(ending.finalMessage.text);
    const record: RecoveryRecord = { id, threadId: thread.id, projectId: thread.projectId, runId: ending.runId,
      messageId: ending.finalMessage.id, messageRevision: ending.finalMessage.revision, observedAt: Date.now(),
      classification: null, action: canClassify && !held ? "observed" : "suppressed",
      reason: held ?? (canClassify ? PENDING_REASON
        : `${selected ? "Classification paused or policy changed before ending admission" : "No operational detector selected"}; live ending inventoried without historical replay or dispatch`),
      detector: selected?.id ?? null, judgment: null,
      gate: held ? HELD_GATE[held]! : canClassify ? GATE.pending : unclassifiedGate, text: ref };
    const previous = latestRecords.get(thread.id);
    addRecord(record);
    await bb.storage.kv.set(`${TEXT_KEY}${id}`, text);
    await persist(record);
    if (previous?.gate !== undefined && !previous.outcome) {
      // The next ending is the previous decision's outcome only inside its window.
      previous.outcome = record.observedAt - previous.observedAt > OUTCOME_WINDOW_MS ? noneOutcome(previous)
        : { kind: "next-ending", at: record.observedAt, nextRecordId: id, classification: record.classification, action: record.action, reason: null };
      if (previous.outcome.kind === "next-ending") predecessors.set(id, previous);
      await persist(previous);
    }
    if (records.length > DECISION_LIMITS.count || [...storedBytes.values()].reduce((sum, bytes) => sum + bytes, 0) > DECISION_LIMITS.bytes) await pruneRecords(true);
    if (held) return;
    if (canClassify && selected && !paused && !disposed && detector === selected && window.epoch === classificationEpoch) classifyEnding(record, ending, selected, ready);
    else if (record.action === "observed") {
      decide(record, "suppressed", GATE.cancelledBeforeStart, "Classification was canceled before it began");
      await persist(record);
    }
  }
  // A long run can have thousands of rows since it started. Snapshot the history head first, find
  // the run's root start (turn/started rows only, skipping child turns), then read up to that head.
  // Rows after the head are live and arrive through the normal incremental read, so an ending that
  // lands while this read is in flight is still classified. Bounded so one huge thread cannot stall
  // inventory; past the bound the run is honestly reported as not followable.
  const MAX_BASELINE_PAGES = 50;
  async function readBaseline(thread: ObservedThread): Promise<ThreadEventRow[]> {
    const head = await bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1", types: historyTypes });
    if (!hasActiveExecutionSignal(thread) || head.length === 0 || disposed) return head;
    const headSeq = head[0]!.seq;
    let rootSeq: number | null = null;
    let beforeSeq = String(headSeq + 1);
    for (let page = 0; page < MAX_BASELINE_PAGES && rootSeq === null && !disposed; page++) {
      const starts = await bb.sdk.threads.events.list({ threadId: thread.id, beforeSeq, order: "desc", limit: "100", types: ["turn/started"] });
      const root = starts.find(row => row.type === "turn/started" && row.scope.kind === "turn" && !row.data.parentToolCallId);
      if (root) rootSeq = root.seq;
      if (starts.length < 100) break;
      beforeSeq = String(starts[starts.length - 1]!.seq);
    }
    if (rootSeq === null || disposed) return [];
    // A `/compact` request right before the root start makes that root a maintenance turn, not the run.
    const [before] = await bb.sdk.threads.events.list({ threadId: thread.id, beforeSeq: String(rootSeq), order: "desc", limit: "1", types: ["client/turn/requested", "turn/started"] });
    const rows: ThreadEventRow[] = before?.type === "client/turn/requested" ? [before] : [];
    let afterSeq = String(rootSeq - 1);
    for (let page = 0; page < MAX_BASELINE_PAGES && !disposed; page++) {
      const batch = await bb.sdk.threads.events.list({ threadId: thread.id, afterSeq, order: "asc", limit: "100", types: historyTypes });
      for (const row of batch) if (row.seq <= headSeq) rows.push(row);
      if (batch.length < 100 || batch[batch.length - 1]!.seq >= headSeq) return rows.reverse();
      afterSeq = String(batch[batch.length - 1]!.seq);
    }
    // Ran out of budget before reaching the head: the cursor would be stale, so report not followable.
    return [];
  }
  async function baseline(thread: ObservedThread, capturedRows?: ThreadEventRow[]): Promise<void> {
    const rows = capturedRows ?? await readBaseline(thread);
    if (disposed) return;
    const cursor: Cursor = { seq: 0, runId: null, finalMessage: null, knownStop: stoppedThreads.has(thread.id), maintenanceRequests: [], maintenance: null };
    const completed = new Set<string>();
    const active = hasActiveExecutionSignal(thread);
    if (active) {
      for (const row of [...rows].reverse()) {
        apply(cursor, row);
        if (row.type === "turn/completed" && row.scope.kind === "turn") completed.add(row.scope.turnId);
      }
    } else {
      cursor.seq = rows[0]?.seq ?? 0;
      // A last-row Stop is known evidence, and a last-row `/compact` request still marks the turn it starts; old idle endings are not replayed.
      if (rows[0]?.type === "system/thread/interrupted" || rows[0]?.type === "client/turn/requested") apply(cursor, rows[0]);
    }
    cursors.set(thread.id, cursor);
    tracker.forget(thread.id);
    if (active && cursor.runId && !completed.has(cursor.runId)) tracker.observe(observation(thread.id, cursor, true));
    const listed = inventory.get(thread.id);
    if (!listed) return;
    if (cursor.knownStop) listed.exclusion = "Observed manual Stop; waits for your next message to re-arm";
    // A thread whose current root is a maintenance turn is only compacting.
    else if (active && !cursor.maintenance && (!cursor.runId || completed.has(cursor.runId))) listed.exclusion = "Live root-turn identity unavailable in bounded public history";
  }
  async function observe(candidate: ObservedThread, window: ClassificationWindow = { epoch: classificationEpoch, paused }): Promise<void> {
    if (disposed) return;
    let thread = freshest(candidate);
    let excluded = await exclusion(thread);
    const newer = freshest(thread);
    if (newer !== thread) { thread = newer; excluded = await exclusion(thread); }
    if (disposed) return;
    noteRunningWork(thread);
    if (thread.archivedAt !== null || thread.deletedAt !== null) {
      cancelClassifications(GATE.archived, "Thread archived or deleted", thread.id);
      inventory.delete(thread.id); cursors.delete(thread.id); liveBaselines.delete(thread.id); tracker.forget(thread.id); return;
    }
    inventory.set(thread.id, { id: thread.id, projectId: thread.projectId, title: thread.title ?? thread.titleFallback,
      status: thread.status, hostId: inventory.get(thread.id)?.hostId ?? null,
      visibility: thread.visibility, parentThreadId: thread.parentThreadId, watched: false, exclusion: excluded });
    if (excluded) {
      cancelClassifications(GATE.ineligible, `Thread became ineligible: ${excluded}`, thread.id);
      tracker.forget(thread.id); cursors.delete(thread.id); liveBaselines.delete(thread.id); return;
    }
    let cursor = cursors.get(thread.id);
    if (!cursor || (!cursor.runId && liveBaselines.has(thread.id))) {
      // An active event samples its live root before waiting behind startup's
      // paginated inventory scan. A later idle snapshot must not erase it.
      if (!liveBaselines.has(thread.id)) await baseline(thread);
      const captured = liveBaselines.get(thread.id);
      if (!captured) return;
      liveBaselines.delete(thread.id);
      const rows = await captured.rows;
      if (disposed) return;
      if (captured.window.paused || captured.window.epoch !== window.epoch) window = captured.window;
      if (rows) await baseline(captured.thread, rows);
      else if (!cursors.has(thread.id)) await baseline(thread);
      cursor = cursors.get(thread.id);
      if (!cursor) return;
    }
    const rows: ThreadEventRow[] = [];
    let afterSeq = cursor.seq;
    for (let page = 0; page < 4; page++) {
      const batch = await bb.sdk.threads.events.list({ threadId: thread.id, afterSeq: String(afterSeq), order: "asc", limit: "100", types: historyTypes });
      if (disposed) return;
      rows.push(...batch);
      if (batch.length < 100) break;
      const nextSeq = Math.max(...batch.map(row => row.seq));
      if (nextSeq <= afterSeq || page === 3) { cancelClassifications(GATE.notFollowable, "Incremental public history exceeded the bounded observation window", thread.id); await baseline(thread); return; }
      afterSeq = nextSeq;
    }
    // Endings are judged only once the whole batch is applied, so one a later row already replaced
    // (a compaction, a newer run, a Stop) never reaches the detector.
    const batch = Promise.withResolvers<void>();
    try {
      for (const row of rows) {
        if (row.seq <= cursor.seq) continue;
        const applied = apply(cursor, row);
        if (applied === "reset" || cursor.knownStop) tracker.forget(thread.id);
        if (applied === "run") {
          tracker.observe(observation(thread.id, cursor, true));
          if (!cursor.knownStop) inventory.get(thread.id)!.exclusion = null;
        }
        if (row.type !== "turn/completed" || row.scope.kind !== "turn" || row.scope.turnId !== cursor.runId) continue;
        const ending = tracker.observe({ ...observation(thread.id, cursor, false), finalMessage: row.data.status === "completed" ? cursor.finalMessage : null });
        if (ending) await recordEnding(thread, ending, window, batch.promise);
      }
      // An idle/starting baseline can have advanced past turn/started before the
      // active announcement arrived. Reconstruct only an unfinished current root.
      if (!cursor.runId && !cursor.maintenance && !cursor.knownStop && hasActiveExecutionSignal(thread)) {
        await baseline(thread);
        return;
      }
      const listed = inventory.get(thread.id);
      if (listed && cursor.knownStop) listed.exclusion = "Observed manual Stop; waits for your next message to re-arm";
      await release(thread.id, batch.promise);
    } finally { batch.resolve(); }
  }
  async function refreshInventory(window: ClassificationWindow = { epoch: classificationEpoch, paused }): Promise<RecoveryStatus> {
    if (disposed) throw new Error("Recovery service is disposed");
    let roleError: string | null = null;
    try {
      const ids = await options.controlThreadIds();
      ownedThreads.clear(); for (const id of ids) ownedThreads.add(id);
      identitiesKnown = true;
    } catch (caught) {
      identitiesKnown = false;
      cancelClassifications(GATE.identities, "Owned control-role identities became unavailable");
      roleError = caught instanceof Error ? caught.message : String(caught);
    }
    try {
      projects = (await bb.sdk.projects.list({ includePersonal: true })).map(project => ({ id: project.id, name: project.name }));
      const seen = new Set<string>();
      for (let offset = 0; !disposed; ) {
        const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 100, offset });
        for (const thread of page) {
          seen.add(thread.id);
          const committed = remember(thread);
          await observe(committed, window);
          const listed = inventory.get(thread.id);
          if (listed && committed.updatedAt <= thread.updatedAt) listed.hostId = thread.environmentHostId;
        }
        if (page.length < 100) break;
        offset += page.length;
      }
      // Offset pages are not an atomic inventory snapshot. Confirm missing rows
      // individually instead of erasing chats activated while the scan ran.
      for (const id of inventory.keys()) if (!seen.has(id) && !disposed) {
        try { await observe(remember(await bb.sdk.threads.get({ threadId: id })), window); }
        catch (caught) {
          // Work that can no longer be read is no longer running for its root.
          workStopped(id);
          bb.log.warn(`Recovery inventory confirmation deferred for ${id}: ${String(caught)}`);
        }
      }
      if (!disposed) { lastObservedAt = Date.now(); error = roleError; changed(); }
      if (!disposed) await pruneRecords();
      return status();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught); changed(); throw caught;
    }
  }
  function scheduleReconciliation(): void {
    if (disposed || !initialized || reconciliationTimer) return;
    reconciliationTimer = setTimeout(() => {
      reconciliationTimer = undefined;
      const window = { epoch: classificationEpoch, paused };
      void serial(async () => { if (!disposed) await refreshInventory(window); })
        .catch(caught => { if (!disposed) bb.log.warn(`Recovery reconciliation deferred: ${String(caught)}`); })
        .finally(scheduleReconciliation);
    }, 30_000);
    reconciliationTimer.unref?.();
  }
  async function start(): Promise<void> {
    if (starting) return starting;
    starting = serial(async () => {
      if (disposed) throw new Error("Recovery service is disposed");
      startedAt = Date.now();
      if (!listenersBound) {
        listenersBound = true;
        const handler = ({ thread }: { thread: ThreadResponse }, activeWake = false) => {
          if (disposed) return;
          const window = { epoch: classificationEpoch, paused };
          const committed = remember(thread, true);
          if (thread.status === "stopping") options.continuation?.cancel(thread.id, CANCEL_REASON.stopping);
          const known = cursors.get(thread.id);
          if (activeWake && hasActiveExecutionSignal(committed) && identitiesKnown && !known?.runId && !known?.maintenance && !liveBaselines.has(thread.id)) {
            const rows = exclusion(committed).then(excluded => excluded || disposed ? null : readBaseline(committed))
              .catch(caught => { bb.log.warn(`Recovery live baseline deferred: ${String(caught)}`); return null; });
            liveBaselines.set(thread.id, { thread: committed, rows, window });
          }
          return serial(async () => {
            if (!initialized || disposed) return;
            try { await observe(committed, window); if (!disposed) { lastObservedAt = Date.now(); changed(); } }
            catch (caught) {
              cancelClassifications(GATE.observationFailed, "Thread observation failed before classification routing", thread.id);
              tracker.forget(thread.id); cursors.delete(thread.id);
              error = caught instanceof Error ? caught.message : String(caught);
              bb.log.warn(`Recovery observation failed: ${error}`); changed();
            }
          });
        };
        bb.events.on("thread.active", payload => handler(payload, true)); bb.events.on("thread.idle", handler); bb.events.on("thread.failed", handler);
        // There is no public thread.updated event. This is the debounced history
        // announcement; periodic inventory reconciliation covers other updates.
        bb.events.on("experimental_thread.events", handler); bb.events.on("thread.created", handler); bb.events.on("thread.unarchived", handler);
        bb.events.on("thread.archived", handler); bb.events.on("thread.deleted", handler);
      }
      const storedPaused = z.boolean().optional().parse(await bb.storage.kv.get("recovery.paused"));
      kv.remember("recovery.paused", storedPaused);
      paused = storedPaused ?? z.boolean().optional().parse(await retainedValue(bb.storage.kv, "recovery.paused")) ?? false;
      for (const key of await retainedKeys(bb.storage.kv, "recovery.stopped.")) {
        if (z.boolean().optional().parse(await retainedValue(bb.storage.kv, key))) stoppedThreads.add(key.slice("recovery.stopped.".length));
      }
      for (const key of await retainedKeys(bb.storage.kv, "recovery.rearmed.")) {
        const at = z.number().optional().parse(await retainedValue(bb.storage.kv, key));
        if (at !== undefined) rearmedAt.set(key.slice("recovery.rearmed.".length), at);
      }
      for (const key of await retainedKeys(bb.storage.kv, RECORD_KEY)) {
        // The own row shadows the immutable imported one; the writer learns which of them storage holds.
        const own = await bb.storage.kv.get(key);
        kv.remember(key, own);
        const record = recordSchema.parse(own ?? await bb.storage.kv.get(`${LEGACY_DATA_PREFIX}${key}`));
        if (recordsById.has(record.id)) continue;
        // Persisted historical observations are never sent back to a detector, including endings a prior process held.
        if (record.action === "observed" || (record.action === "suppressed" && HELD[record.reason] === true)) {
          decide(record, "suppressed", GATE.restart, "Prior process observation retained without historical classification replay"); await persist(record);
        }
        addRecord(record);
      }
      for (const record of records) if (record.outcome?.nextRecordId) predecessors.set(record.outcome.nextRecordId, record);
      await refreshInventory();
      if (disposed) return;
      initialized = true;
      scheduleReconciliation();
      changed();
    }).catch(caught => { starting = null; throw caught; });
    return starting;
  }
  const service: RecoveryService = {
    start, refresh: () => {
      const window = { epoch: classificationEpoch, paused };
      return serial(() => refreshInventory(window));
    }, status,
    records: () => {
      const published = historyRecordIds(records, Date.now());
      return records.filter(record => published.has(record.id)).map(historyRecord);
    },
    async decisions({ cursor, since }) {
      const eligible = await serial(async () => { await settleExpiredOutcomes(Date.now()); return decisionsAfter(records, cursor, since); });
      const decisions = [];
      let bytes = 2;
      for (const record of eligible) {
        if (decisions.length === 200) break;
        const text = record.text ? decodeText(await bb.storage.kv.get(`${TEXT_KEY}${record.id}`)) : null;
        const decision = toDecision(record, text);
        const size = Buffer.byteLength(JSON.stringify(decision)) + 1;
        if (decisions.length && bytes + size > PAGE_BYTES) break;
        decisions.push(decision); bytes += size;
      }
      return { decisions, nextCursor: decisions.length < eligible.length ? decisionCursor(decisions.at(-1)!) : null };
    },
    label(recordId, label) {
      return serial(async () => {
        const record = recordsById.get(recordId);
        if (!record) return null;
        if (label) record.label = label; else delete record.label;
        await persist(record);
        return toDecision(record, record.text ? decodeText(await bb.storage.kv.get(`${TEXT_KEY}${record.id}`)) : null);
      });
    },
    noteNudge,
    rejudge(recordId, judgment) {
      return serial(async () => {
        const record = recordsById.get(recordId);
        if (!record) return null;
        record.judgment = judgment;
        record.classification = judgment.classification;
        if (judgment.classification === "finished") decide(record, "finished", GATE.rejudged, "Re-judged after reload: finished; no continuation dispatched");
        else if (judgment.classification === "continue") decide(record, "suppressed", GATE.rejudged, "Re-judged after reload: not an obstacle; no continuation dispatched");
        await persist(record);
        changed();
        return historyRecord(record);
      });
    },
    cursor(threadId): RecoveryCursor | null {
      const cursor = cursors.get(threadId);
      if (disposed || !initialized || !cursor || inventory.get(threadId)?.exclusion !== null) return null;
      return { runId: cursor.runId, messageId: cursor.finalMessage?.id ?? null, messageRevision: cursor.finalMessage?.revision ?? null, knownStop: cursor.knownStop,
        waitingOn: workWait(threadId)?.kind ?? null };
    },
    threadState(threadId): RecoveryThreadState {
      const listed = inventory.get(threadId);
      const latest = latestRecords.get(threadId);
      const cursor = cursors.get(threadId);
      return { thread: listed ? { ...listed, watched: tracker.isWatching(threadId) } : null, currentRunId: cursor?.runId ?? null,
        latestRecord: latest ? structuredClone(latest) : null, classifying: classifying(), paused, detectorId: detector?.id ?? null,
        wait: workWait(threadId), compacting: cursor?.maintenance != null };
    },
    validateBlocker(blocker) {
      return serial(async () => {
        if (disposed || !initialized) return false;
        if ((await options.controlThreadIds()).includes(blocker.threadId) || disposed) return false;
        const thread = remember(await bb.sdk.threads.get({ threadId: blocker.threadId }));
        await observe(thread);
        const cursor = cursors.get(blocker.threadId);
        const latest = latestRecords.get(blocker.threadId);
        if (disposed || inventory.get(blocker.threadId)?.exclusion !== null || hasActiveExecutionSignal(freshest(thread))
          || cursor?.knownStop !== false || holdReason(blocker.threadId) !== null
          || latest?.id !== blocker.recordId || latest.classification !== blocker.kind) return false;
        if (cursor.finalMessage) return cursor.runId === blocker.runId && cursor.finalMessage.id === blocker.messageId
          && cursor.finalMessage.revision === blocker.messageRevision;
        // An idle thread's startup baseline holds no final message: confirm from native history that the
        // newest root run is still the obstacle's run, completed successfully, and ended on that exact message.
        const rows = await bb.sdk.threads.events.list({ threadId: blocker.threadId, order: "desc", limit: "64", types: ["turn/started", "turn/completed", "item/completed"] });
        const root = rows.find(row => row.type === "turn/started" && row.scope.kind === "turn" && !row.data.parentToolCallId);
        if (disposed || root?.scope.kind !== "turn" || root.scope.turnId !== blocker.runId) return false;
        const completion = rows.find(row => row.type === "turn/completed" && row.scope.kind === "turn" && row.scope.turnId === blocker.runId);
        const message = rows.find(row => row.type === "item/completed" && row.scope.kind === "turn" && row.scope.turnId === blocker.runId
          && row.data.item.type === "agentMessage" && !row.data.item.parentToolCallId);
        return completion?.type === "turn/completed" && completion.data.status === "completed" && completion.seq > (message?.seq ?? Infinity)
          && message?.type === "item/completed" && message.data.item.id === blocker.messageId && message.seq === blocker.messageRevision;
      });
    },
    rearm(threadId, at) {
      const cursor = cursors.get(threadId);
      if (disposed || (!stoppedThreads.has(threadId) && !cursor?.knownStop)) return;
      stoppedThreads.delete(threadId);
      rearmedAt.set(threadId, at);
      if (cursor) cursor.knownStop = false;
      const listed = inventory.get(threadId);
      if (listed?.exclusion?.startsWith("Observed manual Stop")) listed.exclusion = null;
      void serial(async () => { await bb.storage.kv.set(`recovery.stopped.${threadId}`, false); await bb.storage.kv.set(`recovery.rearmed.${threadId}`, at); })
        .catch(caught => bb.log.warn(`Recovery re-arm persistence failed: ${String(caught)}`));
      changed();
    },
    configure(nextDetector) {
      if (detector !== nextDetector) {
        classificationEpoch++;
        successfulJudgments = new WeakMap();
        cancelClassifications(GATE.detectorChanged, "Selected operational detector changed");
      }
      detector = nextDetector; changed(); return status();
    },
    async setPaused(nextPaused) {
      if (paused !== nextPaused) classificationEpoch++;
      paused = nextPaused;
      if (paused) cancelClassifications(GATE.paused, "Passive classification paused; ending will not replay on resume");
      await kv.set("recovery.paused", paused); changed(); return status();
    },
    async dispose() {
      classificationEpoch++;
      disposed = true; initialized = false;
      clearTimeout(reconciliationTimer); reconciliationTimer = undefined;
      for (const timer of settleTimers.values()) clearTimeout(timer);
      settleTimers.clear();
      cancelClassifications(GATE.disposed, "Recovery observer disposed before classification routing");
      liveBaselines.clear();
      await mutations.catch(() => undefined);
      tracker.reconcile([]);
    },
  };
  bb.onDispose(() => service.dispose());
  return service;
}
