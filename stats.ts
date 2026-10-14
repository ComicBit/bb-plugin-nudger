import { z } from "zod";
import { isNoCreditsError, LINE } from "./continuation-copy.js";
import type { DetectorUsageHistory } from "./detector-usage.js";
import type { RecoveryBlocker, RecoveryRecord, RecoveryStatus } from "./recovery-contract.js";

/**
 * TypeSafe System One (Jev) list price: input tokens only; output tokens are free.
 * TypeSafe exposes no billing API, so the ledger stores tokens and the price applies when stats are read.
 */
export const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042;
/** Day = last 14 UTC days, Week = last 12 ISO (Monday) weeks, Month = last 6 calendar months; each ends with the current period. */
export const RANGE_LENGTHS = { day: 14, week: 12, month: 6 } as const;
export type StatsRange = keyof typeof RANGE_LENGTHS;
const OBSTACLES = ["blocker", "permission", "uncertainty"] as const;
const DAY_MS = 86_400_000;
const ATTENTION_LIMIT = 500;
const RECENT_NUDGES = 8;

const id = z.string().min(1).max(4096);
const text = z.string().max(8192);
const count = z.number().int().nonnegative();
const timestamp = z.number().finite().min(0).max(8_640_000_000_000_000);
const day = z.iso.date();
/** `covered: false` periods end before the source's first covered day: shown as "no data yet", never as zero. */
const period = { start: day, covered: z.boolean() };
const ranges = <T extends z.ZodType>(point: T) => z.object({ day: z.array(point).length(RANGE_LENGTHS.day), week: z.array(point).length(RANGE_LENGTHS.week), month: z.array(point).length(RANGE_LENGTHS.month) }).strict();
const nudgePointSchema = z.object({ ...period, nudges: count }).strict();
const jevPointSchema = z.object({ ...period, requests: count, errors: count, inputTokens: count, outputTokens: count, costUsd: z.number().finite().nonnegative() }).strict();
/** An obstacle that current public thread state confirms: the same set Headquarters shows under Needs your attention. */
export const attentionItemSchema = z.object({
  id, threadId: id, projectId: id, title: text, project: text.nullable(),
  kind: z.enum(OBSTACLES), observedAt: timestamp, summary: text,
}).strict();
export const statsSchema = z.object({
  version: z.literal(1),
  generatedAt: timestamp,
  nudges: z.object({
    coverageStart: day.nullable(), series: ranges(nudgePointSchema),
    recent: z.array(z.object({ recordId: id, threadId: id, title: text, observedAt: timestamp, reason: text }).strict()).max(RECENT_NUDGES),
  }).strict(),
  /** Null when the Jev call ledger cannot be read. */
  jev: z.object({ coverageStart: day.nullable(), series: ranges(jevPointSchema), outOfCredits: z.boolean(), usdPerMillionInputTokens: z.number().positive() }).strict().nullable(),
  attention: z.array(attentionItemSchema).max(ATTENTION_LIMIT),
}).strict();
export type NudgerStats = z.infer<typeof statsSchema>;
export type AttentionItem = z.infer<typeof attentionItemSchema>;

const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Every period of each range ending at `now`, oldest first; the current period ends today. */
function periods(now: number): Record<StatsRange, Array<{ start: number; end: number }>> {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const span = (starts: number[], end: (start: number, index: number) => number) => starts.map((start, index) => ({ start, end: Math.min(end(start, index), todayMs) }));
  const days = Array.from({ length: RANGE_LENGTHS.day }, (_unused, index) => todayMs - (RANGE_LENGTHS.day - 1 - index) * DAY_MS);
  const monday = todayMs - ((today.getUTCDay() + 6) % 7) * DAY_MS;
  const weeks = Array.from({ length: RANGE_LENGTHS.week }, (_unused, index) => monday - (RANGE_LENGTHS.week - 1 - index) * 7 * DAY_MS);
  const months = Array.from({ length: RANGE_LENGTHS.month + 1 }, (_unused, index) => Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (RANGE_LENGTHS.month - 1 - index), 1));
  return {
    day: span(days, start => start),
    week: span(weeks, start => start + 6 * DAY_MS),
    month: span(months.slice(0, -1), (_start, index) => months[index + 1]! - DAY_MS),
  };
}

/** Sums UTC daily values into every range's periods. */
function rangeTotals<K extends string>(daily: ReadonlyMap<string, Readonly<Record<K, number>>>, keys: readonly K[], now: number, coverageStart: string | null): Record<StatsRange, Array<Record<K, number> & { start: string; covered: boolean }>> {
  const all = periods(now);
  const totals = (list: Array<{ start: number; end: number }>) => list.map(({ start, end }) => {
    const total = Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;
    for (let time = start; time <= end; time += DAY_MS) {
      const values = daily.get(isoDate(time));
      if (values) for (const key of keys) total[key] += values[key];
    }
    return { ...total, start: isoDate(start), covered: coverageStart === null || isoDate(end) >= coverageStart };
  });
  return { day: totals(all.day), week: totals(all.week), month: totals(all.month) };
}

const SUMMARY_LIMIT = 180;
/** One readable sentence from a Markdown agent message; the full text stays in the thread. */
export function summarize(message: string): string {
  const plain = message
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^.+?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
  const chosen = sentence.length >= 40 || sentence === plain ? sentence : plain;
  if (chosen.length <= SUMMARY_LIMIT) return chosen;
  const cut = chosen.slice(0, SUMMARY_LIMIT);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 120 ? cut.lastIndexOf(" ") : SUMMARY_LIMIT).trimEnd()}…`;
}

export interface StatsInput {
  /** Every retained record, own and imported. */
  records: readonly RecoveryRecord[];
  /** Jev call ledger; null when it cannot be read. */
  jevUsage: DetectorUsageHistory | null;
  status: Pick<RecoveryStatus, "startedAt" | "threads" | "projects">;
  /** Obstacles already revalidated against current thread state. */
  liveBlockers: readonly RecoveryBlocker[];
  now: number;
}

/** The same facts Headquarters' Nudges and Jev costs cards show, plus every current obstacle. */
export function computeStats({ records, jevUsage, status, liveBlockers, now }: StatsInput): NudgerStats {
  const threads = new Map(status.threads.map(thread => [thread.id, thread]));
  const projects = new Map(status.projects.map(project => [project.id, project.name]));
  const titleOf = (threadId: string) => threads.get(threadId)?.title ?? threadId;

  const nudged = records.filter(record => record.action === "nudged").sort((a, b) => a.observedAt - b.observedAt);
  const nudgesByDay = new Map<string, { nudges: number }>();
  for (const record of nudged) {
    const bucket = nudgesByDay.get(isoDate(record.observedAt)) ?? { nudges: 0 };
    bucket.nudges++;
    nudgesByDay.set(isoDate(record.observedAt), bucket);
  }
  // Nudges exist only since records were retained (including imported Headquarters history).
  const firstRecordAt = records.reduce<number | null>((earliest, record) => Math.min(earliest ?? record.observedAt, record.observedAt), status.startedAt);
  const nudgeCoverage = firstRecordAt === null ? null : isoDate(firstRecordAt);

  let jev: NudgerStats["jev"] = null;
  if (jevUsage) {
    const usage = rangeTotals(new Map(Object.entries(jevUsage.days)), ["requests", "errors", "inputTokens", "outputTokens"], now, jevUsage.since);
    const priced = (range: StatsRange) => usage[range].map(point => ({ ...point, costUsd: point.inputTokens * JEV_USD_PER_MILLION_INPUT_TOKENS / 1_000_000 }));
    // The newest Jev ending decides: once credits return, the next successful check clears the warning.
    const latestJev = records.filter(record => record.detector?.startsWith("typesafe-jev") && (record.action === "error" || record.judgment !== null))
      .reduce<RecoveryRecord | null>((latest, record) => !latest || record.observedAt > latest.observedAt ? record : latest, null);
    jev = { coverageStart: jevUsage.since, series: { day: priced("day"), week: priced("week"), month: priced("month") },
      outOfCredits: latestJev?.action === "error" && isNoCreditsError(latestJev.reason), usdPerMillionInputTokens: JEV_USD_PER_MILLION_INPUT_TOKENS };
  }

  const item = (threadId: string, projectId: string): Pick<AttentionItem, "threadId" | "projectId" | "title" | "project"> =>
    ({ threadId, projectId, title: titleOf(threadId), project: projects.get(projectId) ?? null });
  const attention = new Map<string, AttentionItem>();
  for (const blocker of liveBlockers) {
    attention.set(blocker.threadId, { id: blocker.recordId, ...item(blocker.threadId, blocker.projectId), kind: blocker.kind, observedAt: blocker.observedAt, summary: summarize(blocker.finalAssistantMessage) || LINE[blocker.kind].text });
  }

  return {
    version: 1,
    generatedAt: now,
    nudges: {
      coverageStart: nudgeCoverage,
      series: rangeTotals(nudgesByDay, ["nudges"], now, nudgeCoverage),
      recent: nudged.slice(-RECENT_NUDGES).reverse().map(record => ({ recordId: record.id, threadId: record.threadId, title: titleOf(record.threadId), observedAt: record.observedAt, reason: record.reason.slice(0, 8192) })),
    },
    jev,
    attention: [...attention.values()].sort((a, b) => b.observedAt - a.observedAt).slice(0, ATTENTION_LIMIT),
  };
}
