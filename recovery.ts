import { z } from "zod";
import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { SCHEDULED_REASON, type Continuation } from "./continuation.js";
import { CANCEL_REASON, HELD_REASON, WITHHELD_REASON } from "./continuation-copy.js";
/** Six months of daily nudge history, independently of any dashboard consumer. */
const DAILY_HISTORY_DAYS = 183;
import type { FinalMessageClassifier, RecoveryBlocker, RecoveryCursor, RecoveryInventoryProject, RecoveryInventoryThread, RecoveryRecord, RecoveryService, RecoveryStatus, RecoveryThreadState, RecoveryWorkflowWait, ThreadEventRow } from "./recovery-contract.js";
import { createKvWriter } from "./kv-writer.js";
import { WORKFLOW_SETTLE_MS, workflowOwner, workflowStepRunning } from "./workflow-steps.js";
import { retainedKeys, retainedValue } from "./migration-storage.js";
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
  continuation?: Pick<Continuation, "enabled" | "schedule" | "cancel" | "latest">;
}

const recordSchema: z.ZodType<RecoveryRecord> = z.object({
  id: z.string(), threadId: z.string(), projectId: z.string(), runId: z.string(), messageId: z.string(),
  messageRevision: z.number().int().nonnegative(), observedAt: z.number(),
  classification: z.enum(["continue", "finished", "blocker", "permission", "uncertainty"]).nullable(),
  action: z.enum(["observed", "finished", "reported", "suppressed", "nudged", "discarded", "error"]),
  reason: z.string(), detector: z.string().nullable(),
  judgment: z.object({
    classification: z.enum(["continue", "finished", "blocker", "permission", "uncertainty"]), model: z.string(), latencyMs: z.number(),
    usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), cost: z.object({ amount: z.number(), currency: z.string() }).nullable() }),
    confidence: z.number().nullable(), probabilities: z.record(z.string(), z.number()).nullable(),
    questions: z.record(z.string(), z.object({ choice: z.string(), confidence: z.number(), probabilities: z.record(z.string(), z.number()) })).nullable(),
  }).nullable(),
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
const HELD: Record<string, true> = { [HELD_REASON.workflow]: true, [HELD_REASON.maintenance]: true };
const DAY_MS = 86_400_000;
/** Every record is kept this long; older ones only while a reader still needs them (see retainedRecordIds). */
export const RECORD_RECENT_MS = 7 * DAY_MS;
const PRUNE_INTERVAL_MS = 3_600_000;

/**
 * The records worth keeping at `now`: the last week's; nudges inside the dashboard's daily history; each
 * thread's latest (recovery's own state); each detector's newest call outcome (the out-of-credits warning);
 * and the oldest, which anchors the nudge history's coverage start.
 */
export function retainedRecordIds(records: readonly RecoveryRecord[], now: number): Set<string> {
  const keep = new Set<string>();
  const latest = new Map<string, RecoveryRecord>();
  const outcomes = new Map<string, RecoveryRecord>();
  let oldest: RecoveryRecord | null = null;
  for (const record of records) {
    const age = now - record.observedAt;
    if (age <= RECORD_RECENT_MS || (record.action === "nudged" && age <= DAILY_HISTORY_DAYS * DAY_MS)) keep.add(record.id);
    if (record.observedAt >= (latest.get(record.threadId)?.observedAt ?? -Infinity)) latest.set(record.threadId, record);
    if (record.detector !== null && (record.judgment !== null || record.action === "error") && record.observedAt >= (outcomes.get(record.detector)?.observedAt ?? -Infinity)) outcomes.set(record.detector, record);
    if (!oldest || record.observedAt < oldest.observedAt) oldest = record;
  }
  for (const record of [...latest.values(), ...outcomes.values(), ...(oldest ? [oldest] : [])]) keep.add(record.id);
  return keep;
}

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
  const recordIds = new Set<string>();
  // Records are mutated in place, so the latest reference per thread stays current.
  const latestRecords = new Map<string, RecoveryRecord>();
  // Only a successful judgment from this runtime and the same detector instance can survive a hold.
  let successfulJudgments = new WeakMap<RecoveryRecord, NonNullable<RecoveryRecord["judgment"]>>();
  // Running hidden workflow steps per owner thread, each running step's owner, and when an owner
  // with no step left running stops waiting.
  const runningSteps = new Map<string, Set<string>>();
  const stepOwners = new Map<string, string>();
  const settling = new Map<string, number>();
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
    records.push(record); recordIds.add(record.id);
    const latest = latestRecords.get(record.threadId);
    if (!latest || record.observedAt >= latest.observedAt) latestRecords.set(record.threadId, record);
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
  function persist(record: RecoveryRecord): Promise<void> {
    return bb.storage.kv.set(`recovery.records.${record.id}`, record);
  }
  /** Drops records no reader needs any more (at most hourly); runs inside `serial`. */
  async function pruneRecords(): Promise<void> {
    const now = Date.now();
    if (now - prunedAt < PRUNE_INTERVAL_MS) return;
    prunedAt = now;
    const keep = retainedRecordIds(records, now);
    const dropped = records.filter(record => !keep.has(record.id));
    if (!dropped.length) return;
    records.splice(0, records.length, ...records.filter(record => keep.has(record.id)));
    try {
      for (const record of dropped) {
        recordIds.delete(record.id);
        await bb.storage.kv.delete(`recovery.records.${record.id}`);
      }
    } catch (caught) { bb.log.warn(`Recovery record pruning deferred: ${String(caught)}`); }
  }
  /**
   * Cancels in-flight classification, recording `reason` on its ending. Anything that cancels it,
   * other than a new hold, also ends a held ending's wait.
   */
  function cancelClassifications(reason: string, threadId?: string): void {
    const canceled: RecoveryRecord[] = [];
    for (const [id, job] of jobs) {
      if (threadId !== undefined && job.record.threadId !== threadId) continue;
      job.controller.abort();
      jobs.delete(id);
      if (job.record.action !== "observed") continue;
      job.record.action = "suppressed";
      job.record.reason = reason;
      canceled.push(job.record);
    }
    if (HELD[reason] !== true) {
      for (const id of threadId === undefined ? [...latestRecords.keys()] : [threadId]) {
        const held = heldEnding(id);
        if (!held) continue;
        held.action = "suppressed";
        held.reason = reason;
        canceled.push(held);
      }
    }
    if (canceled.length) {
      void serial(async () => { for (const record of canceled) await persist(record); }).catch(caught => bb.log.warn(`Recovery cancellation persistence failed: ${String(caught)}`));
      changed();
    }
  }
  /** A job that found its own ending stale stops; other jobs and holds on the thread are not its to cancel. */
  function abandon(job: ClassificationJob, reason: string): void {
    job.controller.abort();
    if (jobs.get(job.record.id) !== job) return;
    jobs.delete(job.record.id);
    if (job.record.action !== "observed") return;
    job.record.action = "suppressed";
    job.record.reason = reason;
    void serial(() => persist(job.record)).catch(caught => bb.log.warn(`Recovery cancellation persistence failed: ${String(caught)}`));
    changed();
  }
  function workflowWait(threadId: string): RecoveryWorkflowWait | null {
    const running = runningSteps.get(threadId)?.size ?? 0;
    if (running > 0) return { running, settlingUntil: null };
    const until = settling.get(threadId);
    return until !== undefined && until > Date.now() ? { running: 0, settlingUntil: until } : null;
  }
  /** What keeps the thread's latest ending from being judged now: a compaction or its workflow. */
  function holdReason(threadId: string): string | null {
    if (cursors.get(threadId)?.maintenance) return HELD_REASON.maintenance;
    return workflowWait(threadId) ? HELD_REASON.workflow : null;
  }
  /** The thread's latest ending when it waits to be judged: held, or its nudge withheld for the workflow. */
  function heldEnding(threadId: string): RecoveryRecord | null {
    const record = latestRecords.get(threadId);
    if (!record) return null;
    if (record.action === "suppressed" && HELD[record.reason] === true) return record;
    const nudge = record.action === "nudged" ? options.continuation?.latest(threadId) : null;
    return nudge?.state === "withheld" && nudge.cancelReason === WITHHELD_REASON.workflow
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
    record.action = "observed";
    record.reason = PENDING_REASON;
    record.classification = null;
    record.judgment = null;
    record.detector = selected.id;
    classifyEnding(record, observation(threadId, cursor, false), selected, ready, previousJudgment);
    await persist(record);
    changed();
  }
  /** A maintenance turn started: the previous ending's classification and nudge wait until it finishes. */
  function holdForMaintenance(threadId: string): void {
    cancelClassifications(HELD_REASON.maintenance, threadId);
    options.continuation?.cancel(threadId, CANCEL_REASON.maintenance);
    const record = latestRecords.get(threadId);
    const nudge = options.continuation?.latest(threadId);
    if (record?.action !== "nudged" || nudge?.state !== "cancelled" || nudge.cancelReason !== CANCEL_REASON.maintenance
      || nudge.runId !== record.runId || nudge.messageId !== record.messageId || nudge.messageRevision !== record.messageRevision) return;
    record.action = "suppressed";
    record.reason = HELD_REASON.maintenance;
    void serial(() => persist(record)).catch(caught => bb.log.warn(`Recovery hold persistence failed: ${String(caught)}`));
    changed();
  }
  /** Hidden workflow steps are never judged themselves; their lifecycle is what their owner waits on. */
  function noteWorkflowStep(thread: ObservedThread): void {
    const owner = workflowOwner(thread);
    const runningFor = owner !== null && workflowStepRunning(thread) ? owner : null;
    if (stepOwners.has(thread.id) && stepOwners.get(thread.id) !== runningFor) stepStopped(thread.id);
    if (runningFor === null || stepOwners.has(thread.id)) return;
    stepOwners.set(thread.id, runningFor);
    runningSteps.set(runningFor, (runningSteps.get(runningFor) ?? new Set()).add(thread.id));
    settling.delete(runningFor);
    clearTimeout(settleTimers.get(runningFor));
    settleTimers.delete(runningFor);
  }
  function stepStopped(stepId: string): void {
    const owner = stepOwners.get(stepId);
    if (owner === undefined) return;
    stepOwners.delete(stepId);
    const steps = runningSteps.get(owner)!;
    steps.delete(stepId);
    if (steps.size) return;
    runningSteps.delete(owner);
    const until = Date.now() + WORKFLOW_SETTLE_MS;
    settling.set(owner, until);
    armSettle(owner, until);
  }
  function armSettle(owner: string, until: number): void {
    clearTimeout(settleTimers.get(owner));
    const timer = setTimeout(() => {
      settleTimers.delete(owner);
      void serial(async () => {
        if (disposed || runningSteps.has(owner) || settling.get(owner) !== until) return;
        if (until > Date.now()) { armSettle(owner, until); return; }
        settling.delete(owner);
        await release(owner);
        changed();
      }).catch(caught => { if (!disposed) bb.log.warn(`Recovery workflow release deferred: ${String(caught)}`); });
    }, Math.max(0, until - Date.now()));
    timer.unref?.();
    settleTimers.set(owner, timer);
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
    if (cursor.runId !== turnId) cancelClassifications("A later root execution superseded the classified ending", threadId);
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
      cancelClassifications("Observed manual Stop; waits for your next message to re-arm", row.threadId);
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
      cancelClassifications("Root history was cleared or compacted before classification admission", row.threadId);
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
        if (controlsBeforeCall.includes(record.threadId)) { abandon(job, "Thread became a control conversation before classification"); return; }
        if (job.controller.signal.aborted || disposed) return;
        const judgment = previousJudgment ?? await selected.classify(ending.finalMessage!.text, { signal: job.controller.signal });
        if (job.controller.signal.aborted || disposed) return;
        const controlsBeforeRouting = await options.controlThreadIds();
        if (controlsBeforeRouting.includes(record.threadId)) { abandon(job, "Thread became a control conversation before routing"); return; }
        if (job.controller.signal.aborted || disposed) return;
        let validatedVersion = 0;
        const blocker = await serial(async (): Promise<RecoveryBlocker | null> => {
          if (!currentEnding(job)) {
            abandon(job, "The observed root ending is no longer current for classification routing");
            return null;
          }
          const thread = remember(await bb.sdk.threads.get({ threadId: record.threadId }));
          validatedVersion = latestThreads.get(thread.id)?.version ?? 0;
          await observe(thread);
          if (!currentEnding(job) || (latestThreads.get(thread.id)?.version ?? 0) !== validatedVersion) {
            abandon(job, "Lifecycle or final-message evidence changed before classification routing");
            return null;
          }
          const nextRecord: RecoveryRecord = { ...record, classification: judgment.classification, judgment };
          if (judgment.classification === "continue" && options.continuation?.enabled(record.threadId)) {
            // Workflow release may reuse this judgment, but admission and the nudge are always fresh.
            const held = holdReason(record.threadId);
            nextRecord.action = held ? "suppressed" : "nudged";
            nextRecord.reason = held ?? SCHEDULED_REASON;
          } else if (judgment.classification === "continue") {
            nextRecord.action = "suppressed";
            nextRecord.reason = "Continuation candidate classified, but auto-continue is off for this thread";
          } else if (judgment.classification === "finished") {
            nextRecord.action = "finished";
            nextRecord.reason = "Selected detector classified the same live root final assistant message as finished; no continuation dispatched";
          } else {
            nextRecord.reason = "Live final-message obstacle classified; reporting is not authorization or continuation admission";
          }
          await persist(nextRecord);
          if (!currentEnding(job) || (latestThreads.get(thread.id)?.version ?? 0) !== validatedVersion) {
            abandon(job, "Classification result canceled while it was being persisted");
            return null;
          }
          Object.assign(record, nextRecord);
          successfulJudgments.set(record, judgment);
          changed();
          if (record.action === "nudged") {
            const nudge = await options.continuation!.schedule(record);
            if (nudge.state === "cancelled" || nudge.state === "withheld") {
              record.action = "suppressed";
              record.reason = `Continuation ${nudge.state}: ${nudge.cancelReason ?? "no reason recorded"}`;
              await persist(record);
              changed();
            }
            return null;
          }
          if (judgment.classification === "continue" || judgment.classification === "finished") return null;
          return { recordId: record.id, threadId: record.threadId, projectId: record.projectId, runId: record.runId,
            messageId: record.messageId, messageRevision: record.messageRevision, kind: judgment.classification,
            finalAssistantMessage: ending.finalMessage!.text, observedAt: record.observedAt };
        });
        if (!blocker) return;
        // Pause/configuration/Stop/disposal can happen while persistence is awaited.
        if (!currentEnding(job) || (latestThreads.get(record.threadId)?.version ?? 0) !== validatedVersion) {
          abandon(job, "Classification routing canceled by newer lifecycle evidence");
          return;
        }
        await options.reportBlocker(blocker);
        await serial(async () => {
          if (disposed || job.controller.signal.aborted) return;
          record.action = "reported";
          record.reason = "Live final-message obstacle published by Nudger; no project work or continuation authorized";
          await persist(record);
          changed();
        });
      } catch (caught) {
        if (disposed || job.controller.signal.aborted) return;
        await serial(async () => {
          if (disposed || job.controller.signal.aborted) return;
          record.action = "error";
          record.reason = `Final-message classification/reporting failed: ${caught instanceof Error ? caught.message : String(caught)}`;
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
    if (recordIds.has(id)) return;
    const selected = detector;
    const canClassify = (initialized || starting !== null) && !disposed && identitiesKnown && !paused
      && !window.paused && window.epoch === classificationEpoch && selected !== null;
    // A thread waiting on its workflow keeps its ending unjudged until the wait ends.
    const held = canClassify ? holdReason(thread.id) : null;
    const record: RecoveryRecord = { id, threadId: thread.id, projectId: thread.projectId, runId: ending.runId,
      messageId: ending.finalMessage.id, messageRevision: ending.finalMessage.revision, observedAt: Date.now(),
      classification: null, action: canClassify && !held ? "observed" : "suppressed",
      reason: held ?? (canClassify ? PENDING_REASON
        : `${selected ? "Classification paused or policy changed before ending admission" : "No operational detector selected"}; live ending inventoried without historical replay or dispatch`),
      detector: selected?.id ?? null, judgment: null };
    addRecord(record);
    await persist(record);
    if (held) return;
    if (canClassify && selected && !paused && !disposed && detector === selected && window.epoch === classificationEpoch) classifyEnding(record, ending, selected, ready);
    else if (record.action === "observed") {
      record.action = "suppressed"; record.reason = "Classification was canceled before it began";
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
    noteWorkflowStep(thread);
    if (thread.archivedAt !== null || thread.deletedAt !== null) {
      cancelClassifications("Thread archived or deleted", thread.id);
      inventory.delete(thread.id); cursors.delete(thread.id); liveBaselines.delete(thread.id); tracker.forget(thread.id); return;
    }
    inventory.set(thread.id, { id: thread.id, projectId: thread.projectId, title: thread.title ?? thread.titleFallback,
      status: thread.status, hostId: inventory.get(thread.id)?.hostId ?? null,
      visibility: thread.visibility, parentThreadId: thread.parentThreadId, watched: false, exclusion: excluded });
    if (excluded) {
      cancelClassifications(`Thread became ineligible: ${excluded}`, thread.id);
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
      if (nextSeq <= afterSeq || page === 3) { cancelClassifications("Incremental public history exceeded the bounded observation window", thread.id); await baseline(thread); return; }
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
      cancelClassifications("Owned control-role identities became unavailable");
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
          // A step that can no longer be read is no longer running for its owner.
          stepStopped(id);
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
              cancelClassifications("Thread observation failed before classification routing", thread.id);
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
      for (const key of await retainedKeys(bb.storage.kv, "recovery.records.")) {
        const record = recordSchema.parse(await retainedValue(bb.storage.kv, key));
        if (recordIds.has(record.id)) continue;
        // Persisted historical observations are never sent back to a detector, including endings a prior process held.
        if (record.action === "observed" || (record.action === "suppressed" && HELD[record.reason] === true)) {
          record.action = "suppressed"; record.reason = "Prior process observation retained without historical classification replay"; await persist(record);
        }
        addRecord(record);
      }
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
    }, status, records: () => structuredClone(records),
    cursor(threadId): RecoveryCursor | null {
      const cursor = cursors.get(threadId);
      if (disposed || !initialized || !cursor || inventory.get(threadId)?.exclusion !== null) return null;
      return { runId: cursor.runId, messageId: cursor.finalMessage?.id ?? null, messageRevision: cursor.finalMessage?.revision ?? null, knownStop: cursor.knownStop,
        waitingForWorkflow: workflowWait(threadId) !== null };
    },
    threadState(threadId): RecoveryThreadState {
      const listed = inventory.get(threadId);
      const latest = latestRecords.get(threadId);
      const cursor = cursors.get(threadId);
      return { thread: listed ? { ...listed, watched: tracker.isWatching(threadId) } : null, currentRunId: cursor?.runId ?? null,
        latestRecord: latest ? structuredClone(latest) : null, classifying: classifying(), paused, detectorId: detector?.id ?? null,
        workflow: workflowWait(threadId), compacting: cursor?.maintenance != null };
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
        cancelClassifications("Selected operational detector changed");
      }
      detector = nextDetector; changed(); return status();
    },
    async setPaused(nextPaused) {
      if (paused !== nextPaused) classificationEpoch++;
      paused = nextPaused;
      if (paused) cancelClassifications("Passive classification paused; ending will not replay on resume");
      await kv.set("recovery.paused", paused); changed(); return status();
    },
    async dispose() {
      classificationEpoch++;
      disposed = true; initialized = false;
      clearTimeout(reconciliationTimer); reconciliationTimer = undefined;
      for (const timer of settleTimers.values()) clearTimeout(timer);
      settleTimers.clear();
      cancelClassifications("Recovery observer disposed before classification routing");
      liveBaselines.clear();
      await mutations.catch(() => undefined);
      tracker.reconcile([]);
    },
  };
  bb.onDispose(() => service.dispose());
  return service;
}
