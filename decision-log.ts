import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { z } from "zod";
import { CANCEL_REASON, WITHHELD_REASON } from "./continuation-copy.js";
import type { RecoveryDecision, RecoveryNudgeDecision, RecoveryOutcome, RecoveryRecord, RecoveryTextRef } from "./recovery-contract.js";

/**
 * The decision log: why Nudger did what it did with each ending, kept for a month so its quality can be studied.
 * Records live at `recovery.records.<id>`; each one's judged text is stored once, Brotli-compressed, at `recovery.text.<id>`.
 */
const DAY_MS = 86_400_000;
export const RECORD_KEY = "recovery.records.";
export const TEXT_KEY = "recovery.text.";
/** Six months of daily nudge history, independently of any dashboard consumer. */
export const DAILY_HISTORY_DAYS = 183;
/** The v1 history view keeps every record this long; older ones only while a reader still needs them (see historyRecordIds). */
export const RECORD_RECENT_MS = 7 * DAY_MS;
/** Every decision, whatever its action, stays in the log this long. */
export const DECISION_RETENTION_MS = 30 * DAY_MS;
/** What a thread did within this long after an ending is that decision's outcome; after it, "none". */
export const OUTCOME_WINDOW_MS = DAY_MS;
/** Same cap as a published obstacle's final message. */
export const DECISION_TEXT_CHARS = 24_576;
/**
 * Hard storage caps, oldest pruned first. Sized from live data on 2026-10-14: at most 296 endings/day
 * (≈200 typical), ≈970 B per record and ≈1.4 KB per Brotli+base64 text (2.7 KB raw), so 30 days at the
 * peak rate is ≈8.9k records ≈ 21 MB. The caps leave ≈12% headroom over that peak.
 */
export const DECISION_LIMITS = { count: 10_000, bytes: 24 * 1024 * 1024 } as const;

/** Stable ids for what decided an ending's action (`gate`) or stopped its nudge (`nudge.gate`). */
export const GATE = {
  /** Live ending admitted; Jev's answer is pending. */
  pending: "pending",
  noDetector: "no-detector",
  /** Global pause (or the pause window an ending was observed in). */
  paused: "paused",
  identities: "identities-unavailable",
  /** Detector or pause changed between the ending and its admission. */
  policyChanged: "policy-changed",
  cancelledBeforeStart: "cancelled-before-classification",
  workflow: "workflow-hold",
  subthread: "subthread-hold",
  maintenance: "maintenance",
  superseded: "superseded",
  stop: "operator-stop",
  historyReset: "history-reset",
  archived: "thread-archived",
  ineligible: "ineligible",
  notFollowable: "not-followable",
  observationFailed: "observation-failed",
  detectorChanged: "detector-changed",
  disposed: "disposed",
  control: "control-thread",
  /** Lifecycle or final-message evidence changed while Jev's answer was routed. */
  stale: "stale-ending",
  autoContinueOff: "auto-continue-off",
  nudge: "nudge-scheduled",
  /** The ending waits on work it started: a late check-in, cancelled by anything reaching the thread first. */
  checkIn: "check-in-scheduled",
  /** NUDGE_STREAK_LIMIT nudges in a row drew no other message; nothing more is sent until something else arrives. */
  nudgeStreak: "nudge-streak",
  finished: "finished",
  obstacle: "obstacle",
  reported: "obstacle-reported",
  detectorError: "detector-error",
  noCredits: "no-credits",
  /** A prior process's pending or held ending, never replayed. */
  restart: "restart",
  rejudged: "rejudged",
  // Send-time gates (a scheduled nudge's own fate).
  operatorCancel: "operator-cancel",
  operatorReplied: "operator-replied",
  freshActivity: "fresh-activity",
  activeExecution: "active-execution",
  messageChanged: "message-changed",
  queued: "queued",
  sendFailed: "send-failed",
  nudgeCancelled: "nudge-cancelled",
  nudgeWithheld: "nudge-withheld",
} as const;

/** The send-time gate that cancelled or withheld a nudge; null while it is pending and once it is sent. */
export function nudgeGate(state: RecoveryNudgeDecision["state"], reason: string | null): string | null {
  if (state === "pending" || state === "sent") return null;
  if (state === "cancelled") {
    if (reason === CANCEL_REASON.countdown) return GATE.operatorCancel;
    if (reason === CANCEL_REASON.turnedOff) return GATE.autoContinueOff;
    if (reason === CANCEL_REASON.paused) return GATE.paused;
    if (reason === CANCEL_REASON.stop || reason === CANCEL_REASON.stopping) return GATE.stop;
    if (reason === CANCEL_REASON.superseded) return GATE.superseded;
    if (reason === CANCEL_REASON.restarted) return GATE.restart;
    if (reason === CANCEL_REASON.maintenance) return GATE.maintenance;
    if (reason === `${CANCEL_REASON.freshActivity}: user`) return GATE.operatorReplied;
    if (reason?.startsWith(CANCEL_REASON.freshActivity)) return GATE.freshActivity;
    if (reason?.startsWith(CANCEL_REASON.sendFailed)) return GATE.sendFailed;
    return GATE.nudgeCancelled;
  }
  if (reason === WITHHELD_REASON.stop) return GATE.stop;
  if (reason === WITHHELD_REASON.newerRun) return GATE.superseded;
  if (reason === WITHHELD_REASON.messageChanged) return GATE.messageChanged;
  if (reason === WITHHELD_REASON.workflow) return GATE.workflow;
  if (reason === WITHHELD_REASON.subthread) return GATE.subthread;
  if (reason === WITHHELD_REASON.joinTurn || reason?.startsWith(WITHHELD_REASON.notIdle)) return GATE.activeExecution;
  if (reason === WITHHELD_REASON.queued) return GATE.queued;
  return GATE.nudgeWithheld;
}

/** Cancels that were the operator's own doing: the countdown's Cancel, turning the thread off, the global pause, or replying first. */
export function operatorCancelled(reason: string | null): boolean {
  return reason === CANCEL_REASON.countdown || reason === CANCEL_REASON.turnedOff || reason === CANCEL_REASON.paused
    || reason === `${CANCEL_REASON.freshActivity}: user`;
}

export function noneOutcome(record: Pick<RecoveryRecord, "observedAt">): RecoveryOutcome {
  return { kind: "none", at: record.observedAt + OUTCOME_WINDOW_MS, nextRecordId: null, classification: null, action: null, reason: null };
}

/** The stored form of a judged text: capped, then Brotli-compressed and base64-encoded inside a JSON object. */
export function encodeText(text: string): { value: { br: string }; ref: RecoveryTextRef } {
  const capped = text.slice(0, DECISION_TEXT_CHARS);
  const br = brotliCompressSync(Buffer.from(capped), { params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } }).toString("base64");
  return { value: { br }, ref: { chars: capped.length, bytes: br.length + 9, truncated: capped.length < text.length } };
}

const storedTextSchema = z.object({ br: z.string() });
/** The stored text, or null when it is missing or unreadable. */
export function decodeText(value: unknown): string | null {
  const stored = storedTextSchema.safeParse(value);
  if (!stored.success) return null;
  try { return brotliDecompressSync(Buffer.from(stored.data.br, "base64")).toString(); } catch { return null; }
}

/**
 * The records the v1 history view publishes at `now`: the last week's; nudges inside the dashboard's daily history;
 * each thread's latest (recovery's own state); each detector's newest call outcome (the out-of-credits warning);
 * and the oldest, which anchors the nudge history's coverage start.
 */
export function historyRecordIds(records: readonly RecoveryRecord[], now: number): Set<string> {
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

export interface RetentionPlan {
  /** Records (and their texts) to delete. */
  drop: Set<string>;
  /** Records kept only for the v1 history view past the log's window: their texts go. */
  dropText: Set<string>;
}

/**
 * What storage keeps at `now`: every decision of the last DECISION_RETENTION_MS, plus what the v1 history view
 * still publishes (text-less past the window). Over either hard cap, the oldest go first: decisions the history view
 * does not need, then, only if still over, the history view's own.
 */
export function planRetention(records: readonly RecoveryRecord[], sizeOf: (record: RecoveryRecord) => number, now: number,
  limits: { count: number; bytes: number } = DECISION_LIMITS): RetentionPlan {
  const history = historyRecordIds(records, now);
  const drop = new Set<string>();
  const dropText = new Set<string>();
  const kept: RecoveryRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    const inLog = now - record.observedAt <= DECISION_RETENTION_MS;
    if (!inLog && !history.has(record.id)) { drop.add(record.id); continue; }
    if (!inLog && record.text) dropText.add(record.id);
    kept.push(record);
    bytes += sizeOf(record) - (dropText.has(record.id) ? record.text!.bytes : 0);
  }
  let count = kept.length;
  if (count <= limits.count && bytes <= limits.bytes) return { drop, dropText };
  kept.sort((a, b) => Number(history.has(a.id)) - Number(history.has(b.id)) || a.observedAt - b.observedAt || a.id.localeCompare(b.id));
  for (const record of kept) {
    if (count <= limits.count && bytes <= limits.bytes) break;
    bytes -= sizeOf(record) - (dropText.has(record.id) ? record.text!.bytes : 0);
    drop.add(record.id); dropText.delete(record.id); count--;
  }
  return { drop, dropText };
}

/** The record as the v1 history view publishes it: no decision-log fields. */
export function historyRecord(record: RecoveryRecord): RecoveryRecord {
  const { gate: _gate, text: _text, nudge: _nudge, outcome: _outcome, label: _label, ...rest } = record;
  return structuredClone(rest);
}

/** The exported decision: the record, its judged text, and every decision field explicit. */
export function toDecision(record: RecoveryRecord, text: string | null): RecoveryDecision {
  const { gate, text: ref, nudge, outcome, label, ...rest } = structuredClone(record);
  return { ...rest, reason: rest.reason.slice(0, 8192), gate: gate ?? null, text, textTruncated: ref?.truncated ?? false,
    nudge: nudge ? { ...nudge, reason: nudge.reason?.slice(0, 8192) ?? null } : null,
    outcome: outcome ? { ...outcome, reason: outcome.reason?.slice(0, 8192) ?? null } : null, label: label ?? null };
}

/** Decision log pages run oldest first; a cursor is the last row's `observedAt:id`, stable while older rows are pruned. */
export function decisionCursor(record: Pick<RecoveryRecord, "observedAt" | "id">): string {
  return `${record.observedAt}:${record.id}`;
}

export function decisionsAfter(records: readonly RecoveryRecord[], cursor: string | null, since?: number): RecoveryRecord[] {
  let after: { observedAt: number; id: string } | null = null;
  if (cursor !== null) {
    const split = cursor.indexOf(":");
    const observedAt = Number(cursor.slice(0, split));
    if (split < 1 || !Number.isFinite(observedAt)) throw new Error("Invalid decision log cursor");
    after = { observedAt, id: cursor.slice(split + 1) };
  }
  return records
    .filter(record => (since === undefined || record.observedAt >= since)
      && (after === null || record.observedAt > after.observedAt || (record.observedAt === after.observedAt && record.id.localeCompare(after.id) > 0)))
    .sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
}
