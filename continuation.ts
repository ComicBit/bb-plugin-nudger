import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CANCEL_REASON, nudgeRejectMessage, WITHHELD_REASON } from "./continuation-copy.js";
import { createKvWriter } from "./kv-writer.js";
import { RECOVERY_NUDGE, type RecoveryCursor, type RecoveryRecord } from "./recovery-contract.js";
import { LEGACY_DATA_PREFIX, LEGACY_SENT_KEY, retainedKeys, retainedValue } from "./migration-storage.js";

export const NUDGE_DELAY_MS = 20_000;
/**
 * A thread waiting on work it started is woken by that work: on 2026-10-12..19, half of those waits were woken within
 * 4.4 minutes and 75% within 13. A check-in fires only when nothing has reached the thread for this long.
 */
export const CHECK_IN_MS = 30 * 60_000;
/** Nudges in a row that drew no other message before Nudger stops nudging the thread; a check-in delay doubles with each. */
export const NUDGE_STREAK_LIMIT = 3;
const LOG_LIMIT = 200;
/** The log is diagnostic: one write per burst (a schedule and its send 20s later), at most this late. */
export const LOG_FLUSH_MS = 30_000;
const NUDGE_KEY = "continuation.nudge.";
const OFF_KEY = "continuation.off.";
const LOG_KEY = "continuation.log";
const SENT_KEY = "continuation.sentCounts";
export const SCHEDULED_REASON = "Continuation scheduled; admission checked at send time";
export const ADMITTED_REASON = "Admitted at send time against an unchanged recovery cursor";

export type NudgeState = "pending" | "cancelled" | "sent" | "withheld";
export interface Nudge {
  nudgeId: string;
  threadId: string;
  runId: string;
  messageId: string;
  messageRevision: number;
  /** Scheduled admission time: the plugin timer sends the nudge (with no core sendAt) at this moment. */
  sendAt: number;
  createdAt: number;
  state: NudgeState;
  cancelReason: string | null;
}
export interface DispatchShape {
  attempt: string;
  initiator: string;
  submission: boolean;
  input: string;
  rows: Array<{ id: string; sendAt: number | null; originPluginId: string | null; initiator: string }>;
}
export interface ContinuationLogEntry {
  at: number;
  event: "scheduled" | "cancelled" | "withheld" | "sent";
  nudgeId: string;
  threadId: string;
  reason: string | null;
  /** The dispatch attempt that caused this transition, when there was one. */
  dispatch?: DispatchShape;
}
export interface ContinuationSnapshot {
  /** Threads the operator turned auto-continue off for; every other eligible thread is on. */
  off: string[];
  pending: Nudge[];
  log: ContinuationLogEntry[];
}
export interface Continuation {
  /** Loads the per-thread off set and persisted nudges; any nudge left pending by a prior process is cancelled. */
  start(): Promise<void>;
  /** Auto-continue is on for every thread unless turned off; nothing is on until persisted state has loaded. */
  enabled(threadId: string): boolean;
  /** Persists the thread's toggle; turning it off cancels its pending nudge. */
  setEnabled(threadId: string, enabled: boolean): Promise<void>;
  /**
   * Schedules RECOVERY_NUDGE for a classified 'continue' ending; a per-thread plugin timer sends it after `delayMs`
   * (the service's delay by default). A thread that is off (or a global pause) yields an already-cancelled nudge.
   */
  schedule(record: RecoveryRecord, delayMs?: number): Promise<Nudge>;
  /** Cancels the thread's pending nudge (Stop evidence, the countdown Cancel); a no-op when none is pending. */
  cancel(threadId: string, reason: string): void;
  /** Cancels every pending nudge (global pause). */
  cancelAll(reason: string): void;
  /** How many nudges this thread has received; survives restarts and the log's size limit. */
  sentCount(threadId: string): number;
  /** Nudges sent to the thread in a row with no other message reaching it in between; this process only. */
  streak(threadId: string): number;
  /** The thread's most recent nudge in any state. */
  latest(threadId: string): Nudge | null;
  /** Synchronous dispatch-hook decision; null means no opinion. */
  decide(context: MessageDispatchHookContext): MessageDispatchHookDecision | null;
  /** Off threads, pending nudges and the recent log, optionally for one thread. */
  snapshot(threadId?: string): ContinuationSnapshot;
  /** Resolves once every queued persistence write and timer-driven send has landed, the debounced log included. */
  flush(): Promise<void>;
  /** Clears every pending timer at once (a timer that already fired no-ops afterwards), then resolves once the debounced log and every queued write have landed. */
  dispose(): Promise<void>;
}
export interface ContinuationOptions {
  bb: BbPluginApi;
  /** Recovery's live cursor for the thread; null when recovery is not observing it. */
  cursor(threadId: string): RecoveryCursor | null;
  /** The global pause; while set nothing is scheduled or admitted. */
  paused?(): boolean;
  delayMs?: number;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Called after every nudge transition and toggle, with the affected thread. */
  onChange?(threadId: string): void;
}

const nudgeSchema: z.ZodType<Nudge> = z.object({
  nudgeId: z.string(), threadId: z.string(), runId: z.string(), messageId: z.string(), messageRevision: z.number(),
  sendAt: z.number(), createdAt: z.number(),
  state: z.enum(["pending", "cancelled", "sent", "withheld"]), cancelReason: z.string().nullable(),
});
const logSchema: z.ZodType<ContinuationLogEntry[]> = z.array(z.object({
  at: z.number(), event: z.enum(["scheduled", "cancelled", "withheld", "sent"]), nudgeId: z.string(), threadId: z.string(),
  reason: z.string().nullable(),
  dispatch: z.object({ attempt: z.string(), initiator: z.string(), submission: z.boolean(), input: z.string(),
    rows: z.array(z.object({ id: z.string(), sendAt: z.number().nullable(), originPluginId: z.string().nullable(), initiator: z.string() })) }).optional(),
}));
const sentCountsSchema = z.record(z.string(), z.number().int().nonnegative());

/** Per-thread sends in a log: a send later withheld (core queued it) never reached the thread. */
function sentFromLog(entries: ContinuationLogEntry[]): Map<string, number> {
  const sent = new Map<string, string>();
  for (const entry of entries) {
    if (entry.event === "sent") sent.set(entry.nudgeId, entry.threadId);
    else if (entry.event === "withheld") sent.delete(entry.nudgeId);
  }
  const counts = new Map<string, number>();
  for (const threadId of sent.values()) counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
  return counts;
}

function defaultSetTimer(callback: () => void, ms: number): unknown {
  const handle = setTimeout(callback, ms);
  handle.unref();
  return handle;
}

export function createContinuation(options: ContinuationOptions): Continuation {
  const { bb } = options;
  const now = options.now ?? Date.now;
  const delayMs = options.delayMs ?? NUDGE_DELAY_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const off = new Set<string>();
  // Threads toggled before persisted state loaded; their live choice wins over the stored one.
  const toggledEarly = new Set<string>();
  /** Each thread's most recent nudge, in any state. */
  const nudges = new Map<string, Nudge>();
  const timers = new Map<string, unknown>();
  let log: ContinuationLogEntry[] = [];
  let importedLog: ContinuationLogEntry[] = [];
  /** Nudges each thread received; sends before loading are added to the stored counts. */
  const sentCounts = new Map<string, number>();
  const inheritedCounts = new Map<string, number>();
  /** Nudges sent since anything else last reached each thread. */
  const streaks = new Map<string, number>();
  let loaded = false;
  let disposed = false;
  let writes: Promise<unknown> = Promise.resolve();
  const kv = createKvWriter(bb.storage.kv);
  let logTimer: NodeJS.Timeout | undefined;
  let sending: Promise<unknown> = Promise.resolve();

  function write(operation: () => Promise<unknown>): void {
    writes = writes.then(operation).catch(caught => bb.log.warn(`Continuation persistence failed: ${String(caught)}`));
  }
  /** Queues one write of the log as it is when the write runs; a log already stored as-is is skipped. */
  function writeLog(): void {
    clearTimeout(logTimer);
    logTimer = undefined;
    write(() => kv.set(LOG_KEY, log));
  }
  function stopTimer(threadId: string): void {
    if (!timers.has(threadId)) return;
    clearTimer(timers.get(threadId));
    timers.delete(threadId);
  }
  function enabled(threadId: string): boolean {
    return loaded && !off.has(threadId);
  }
  // Set for the duration of one synchronous decide() call so transitions record what caused them.
  let dispatching: DispatchShape | undefined;
  function transition(nudge: Nudge, event: ContinuationLogEntry["event"], reason: string | null): void {
    const current = nudges.get(nudge.threadId) === nudge;
    if (event !== "scheduled") nudge.state = event;
    if (event === "cancelled" || event === "withheld") nudge.cancelReason = reason;
    if (current && event !== "scheduled") stopTimer(nudge.threadId);
    if (event === "sent") countSent(nudge.threadId, 1);
    log = [...log, { at: now(), event, nudgeId: nudge.nudgeId, threadId: nudge.threadId, reason, ...(dispatching ? { dispatch: dispatching } : {}) }].slice(-LOG_LIMIT);
    // The nudge is a decision and is written now; the log rides the next flush.
    if (current) {
      const stored = { ...nudge };
      write(() => kv.set(`${NUDGE_KEY}${nudge.threadId}`, stored));
    }
    if (disposed) writeLog();
    else if (!logTimer) {
      logTimer = setTimeout(writeLog, LOG_FLUSH_MS);
      logTimer.unref();
    }
    options.onChange?.(nudge.threadId);
  }
  function ownCounts(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [threadId, total] of sentCounts) {
      const count = Math.max(0, total - (inheritedCounts.get(threadId) ?? 0));
      if (count > 0) result[threadId] = count;
    }
    return result;
  }
  function countSent(threadId: string, delta: number): void {
    const next = Math.max(0, (sentCounts.get(threadId) ?? 0) + delta);
    if (next === 0) sentCounts.delete(threadId);
    else sentCounts.set(threadId, next);
    streaks.set(threadId, Math.max(0, (streaks.get(threadId) ?? 0) + delta));
    if (!loaded) return;
    const counts = ownCounts();
    write(() => kv.set(SENT_KEY, counts));
  }
  function cancelPending(threadId: string, reason: string): void {
    const nudge = nudges.get(threadId);
    if (nudge?.state === "pending") transition(nudge, "cancelled", reason);
  }
  function submissionNudgeId(context: MessageDispatchHookContext): string | null {
    const submission = context.experimental_submission;
    if (submission?.pluginId !== bb.pluginId || typeof submission.data !== "object" || submission.data === null || Array.isArray(submission.data)) return null;
    const id = submission.data.continuationNudge;
    return typeof id === "string" ? id : null;
  }
  function reject(reason: string): MessageDispatchHookDecision {
    return { action: "reject", message: nudgeRejectMessage(reason) };
  }
  function withhold(nudge: Nudge, reason: string): MessageDispatchHookDecision {
    if (nudge.state === "pending") transition(nudge, "withheld", reason);
    return reject(reason);
  }
  function admissionFailure(context: MessageDispatchHookContext, nudge: Nudge): string | null {
    if (nudge.state !== "pending") return `this nudge was already ${nudge.state}${nudge.cancelReason ? ` (${nudge.cancelReason})` : ""}`;
    if (!enabled(nudge.threadId)) return "auto-continue is off for this thread";
    if (options.paused?.()) return "auto-continue is paused";
    if (context.thread.id !== nudge.threadId) return "the attempt targets a different thread than the classified ending";
    const cursor = options.cursor(nudge.threadId);
    if (!cursor) return "recovery is not observing this thread";
    if (cursor.knownStop) return WITHHELD_REASON.stop;
    if (cursor.runId !== nudge.runId) return WITHHELD_REASON.newerRun;
    if (cursor.messageId !== nudge.messageId || cursor.messageRevision !== nudge.messageRevision) return WITHHELD_REASON.messageChanged;
    if (cursor.waitingOn) return WITHHELD_REASON[cursor.waitingOn];
    if (context.thread.status !== "idle") return `${WITHHELD_REASON.notIdle}: ${context.thread.status}`;
    if (context.attempt !== "start-turn") return WITHHELD_REASON.joinTurn;
    return null;
  }
  function decideAttempt(context: MessageDispatchHookContext): MessageDispatchHookDecision | null {
    const submitted = submissionNudgeId(context);
    // Nudger never legitimately queues rows: any owned queued row is unrecognized and fails closed.
    const ownRows = context.queuedMessages.some(row => row.originPluginId === bb.pluginId);
    if (!loaded) {
      if (submitted !== null || ownRows) return reject("continuation state is still loading after a restart");
      return null;
    }
    if (submitted !== null) {
      const nudge = [...nudges.values()].find(candidate => candidate.nudgeId === submitted);
      if (!nudge || nudges.get(nudge.threadId) !== nudge) return reject("this nudge is stale");
      const failure = admissionFailure(context, nudge);
      if (failure) return withhold(nudge, failure);
      transition(nudge, "sent", ADMITTED_REASON);
      return { action: "proceed" };
    }
    const pending = nudges.get(context.thread.id)?.state === "pending" ? nudges.get(context.thread.id)! : null;
    if (ownRows) {
      const reason = "unrecognized queued continuation";
      return pending ? withhold(pending, reason) : reject(reason);
    }
    if (pending) transition(pending, "cancelled", `${CANCEL_REASON.freshActivity}: ${context.initiator}`);
    // Anything else reaching the thread (the operator, another thread, a finished child or task) answers the streak.
    streaks.delete(context.thread.id);
    return null;
  }
  async function send(nudge: Nudge): Promise<void> {
    const result = await bb.sdk.threads.send({ threadId: nudge.threadId, input: [{ type: "text", text: RECOVERY_NUDGE, mentions: [] }], mode: "start",
      pluginSubmission: { pluginId: bb.pluginId, data: { continuationNudge: nudge.nudgeId } } }).catch((caught: unknown) => {
      // A reject by this plugin's own hook already recorded the withheld state.
      if (nudge.state === "pending") transition(nudge, "cancelled", `${CANCEL_REASON.sendFailed}: ${caught instanceof Error ? caught.message : String(caught)}`);
      return null;
    });
    if (result === null) return;
    if (result.delivery === "queued") {
      // Admission must happen at the real send moment; a queued row would dispatch later unchecked.
      if (nudge.state === "pending" || nudge.state === "sent") {
        // Admitted, but core queued it instead of starting the turn: it never reached the thread.
        if (nudge.state === "sent") countSent(nudge.threadId, -1);
        nudge.state = "pending";
        transition(nudge, "withheld", WITHHELD_REASON.queued);
      }
      const queuedMessageId = result.queuedMessage.id;
      await bb.sdk.threads.queuedMessages.delete({ threadId: nudge.threadId, queuedMessageId })
        .catch(caught => bb.log.warn(`Continuation row ${queuedMessageId} not deleted: ${String(caught)}`));
    } else if (nudge.state === "pending") {
      transition(nudge, "sent", "Core started the continuation without a recorded admission pass");
    }
  }
  function fire(nudge: Nudge): void {
    if (nudges.get(nudge.threadId) !== nudge) return;
    timers.delete(nudge.threadId);
    if (disposed || nudge.state !== "pending") return;
    sending = sending.then(() => send(nudge)).catch(caught => bb.log.warn(`Continuation send failed: ${String(caught)}`));
  }

  return {
    async start() {
      for (const key of await retainedKeys(bb.storage.kv, OFF_KEY)) {
        const threadId = key.slice(OFF_KEY.length);
        if (!toggledEarly.has(threadId) && z.boolean().optional().parse(await retainedValue(bb.storage.kv, key))) off.add(threadId);
      }
      // Unreadable logs are not evidence; start a fresh one.
      const parsedLog = logSchema.optional().safeParse(await bb.storage.kv.get(LOG_KEY));
      const storedLog = parsedLog.success ? parsedLog.data ?? [] : [];
      const legacyLog = logSchema.optional().safeParse(await bb.storage.kv.get(`${LEGACY_DATA_PREFIX}${LOG_KEY}`));
      // Imported diagnostic history remains immutable; this package writes only its new log.
      importedLog = legacyLog.success ? legacyLog.data ?? [] : [];
      // A decision taken before loading (or a nudge scheduled meanwhile) is newer than the stored state.
      log = [...storedLog, ...log].slice(-LOG_LIMIT);
      // Legacy totals are immutable; this package persists only its new sends so reloads cannot import twice.
      const legacy = sentCountsSchema.optional().parse(await bb.storage.kv.get(LEGACY_SENT_KEY));
      const inherited = legacy ? new Map(Object.entries(legacy)) : sentFromLog(importedLog);
      for (const [threadId, count] of inherited) {
        inheritedCounts.set(threadId, count);
        sentCounts.set(threadId, (sentCounts.get(threadId) ?? 0) + count);
      }
      const storedCounts = sentCountsSchema.optional().safeParse(await bb.storage.kv.get(SENT_KEY));
      const baseline = storedCounts.success && storedCounts.data ? new Map(Object.entries(storedCounts.data)) : sentFromLog(storedLog);
      if (storedCounts.success) kv.remember(SENT_KEY, storedCounts.data);
      for (const [threadId, count] of baseline) sentCounts.set(threadId, (sentCounts.get(threadId) ?? 0) + count);
      const restored: Nudge[] = [];
      for (const key of await retainedKeys(bb.storage.kv, NUDGE_KEY)) {
        const parsed = nudgeSchema.safeParse(await retainedValue(bb.storage.kv, key));
        if (!parsed.success) continue;
        if (!nudges.has(parsed.data.threadId)) nudges.set(parsed.data.threadId, parsed.data);
        restored.push(parsed.data);
      }
      loaded = true;
      write(() => kv.set(SENT_KEY, ownCounts()));
      for (const nudge of restored) if (nudge.state === "pending") transition(nudge, "cancelled", CANCEL_REASON.restarted);
      await writes;
    },
    enabled,
    async setEnabled(threadId, next) {
      if (!loaded) toggledEarly.add(threadId);
      if (next === !off.has(threadId)) {
        write(() => kv.set(`${OFF_KEY}${threadId}`, !next));
        await writes;
        return;
      }
      if (next) {
        off.delete(threadId);
        write(() => kv.set(`${OFF_KEY}${threadId}`, false));
      } else {
        off.add(threadId);
        cancelPending(threadId, CANCEL_REASON.turnedOff);
        write(() => kv.set(`${OFF_KEY}${threadId}`, true));
      }
      options.onChange?.(threadId);
      await writes;
    },
    async schedule(record, delay = delayMs) {
      cancelPending(record.threadId, CANCEL_REASON.superseded);
      const createdAt = now();
      const nudge: Nudge = { nudgeId: randomUUID(), threadId: record.threadId, runId: record.runId, messageId: record.messageId,
        messageRevision: record.messageRevision, sendAt: createdAt + delay, createdAt, state: "pending", cancelReason: null };
      nudges.set(record.threadId, nudge);
      transition(nudge, "scheduled", SCHEDULED_REASON);
      if (!enabled(record.threadId)) transition(nudge, "cancelled", CANCEL_REASON.turnedOff);
      else if (options.paused?.()) transition(nudge, "cancelled", CANCEL_REASON.paused);
      else if (!disposed) timers.set(record.threadId, setTimer(() => fire(nudge), delay));
      return { ...nudge };
    },
    cancel: cancelPending,
    cancelAll(reason) {
      for (const threadId of [...nudges.keys()]) cancelPending(threadId, reason);
    },
    latest(threadId) {
      const nudge = nudges.get(threadId);
      return nudge ? { ...nudge } : null;
    },
    sentCount: threadId => sentCounts.get(threadId) ?? 0,
    streak: threadId => streaks.get(threadId) ?? 0,
    decide(context) {
      dispatching = {
        attempt: context.attempt, initiator: context.initiator, submission: context.experimental_submission !== null,
        input: context.input.text.slice(0, 80),
        rows: context.queuedMessages.map(row => ({ id: row.id, sendAt: row.sendAt, originPluginId: row.originPluginId, initiator: row.initiator })),
      };
      try { return decideAttempt(context); } finally { dispatching = undefined; }
    },
    snapshot(threadId) {
      const forThread = <T extends { threadId: string }>(rows: T[]) => threadId === undefined ? rows : rows.filter(row => row.threadId === threadId);
      return {
        off: [...off].filter(id => threadId === undefined || id === threadId).sort(),
        pending: forThread([...nudges.values()].filter(nudge => nudge.state === "pending")).map(nudge => ({ ...nudge })),
        log: forThread([...importedLog, ...log]).slice(-20),
      };
    },
    async flush() {
      await sending;
      if (logTimer) writeLog();
      await writes;
    },
    async dispose() {
      disposed = true;
      for (const threadId of [...timers.keys()]) stopTimer(threadId);
      if (logTimer) writeLog();
      await writes;
    },
  };
}
