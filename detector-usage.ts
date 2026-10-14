import { z } from "zod";
import type { FinalMessageClassifier, FinalMessageJudgment, RecoveryRecord } from "./recovery-contract.js";
import { LEGACY_DATA_PREFIX, LEGACY_USAGE_PREFIX } from "./migration-storage.js";

/**
 * Detector call ledger: one KV bucket per detector per UTC day, `usage.detector.<kind>.<YYYY-MM-DD>`.
 * Stores requests, errors and reported tokens; never dollars (Jev has no billing API).
 * `usage.detector.backfilled` holds the first UTC day the ledger covers.
 * Calls are counted in memory and written in batches: a crash loses at most USAGE_FLUSH_MS of counts.
 * Imported Headquarters buckets are immutable, separate from new calls, and combined only on reads.
 */
export const detectorKinds = ["jev"] as const;
export type DetectorKind = typeof detectorKinds[number];
const bucketSchema = z.object({
  requests: z.number().int().nonnegative(), errors: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
}).strict();
export type UsageBucket = z.infer<typeof bucketSchema>;
export interface DetectorUsageHistory {
  /** UTC day → totals; days without calls are absent. */
  days: Record<string, UsageBucket>;
  /** First UTC day the ledger covers (earliest backfilled record, or the day it started). */
  since: string | null;
}
export interface UsageStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
export interface UsageLedger {
  /** Fire-and-forget: counts the call now and writes it within USAGE_FLUSH_MS; failures are logged, never thrown. */
  record(kind: DetectorKind, judgment: FinalMessageJudgment | null, at?: number): void;
  /** One-time import of classifications retained in recovery records; idempotent through the marker key. */
  backfill(records: readonly RecoveryRecord[]): Promise<void>;
  /** Stored days plus calls not yet written; null when the ledger cannot be read. */
  history(kind: DetectorKind): Promise<DetectorUsageHistory | null>;
  /** Writes every counted call now; shutdown awaits it. */
  flush(): Promise<void>;
}
/** Counters are not decisions; one write per day bucket per window instead of one per call. */
export const USAGE_FLUSH_MS = 60_000;

const PREFIX = "usage.detector.";
const MARKER = `${PREFIX}backfilled`;
// Buckets of removed detectors (legacy `usage.detector.luna.*`) stay stored but are never read.
const dayKey = /^usage\.detector\.(jev)\.(\d{4}-\d{2}-\d{2})$/;
const empty = (): UsageBucket => ({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 });
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Detector ids are stable per kind: `typesafe-jev-*`. Other retained detector ids are history only. */
export function detectorKindOf(detectorId: string | null): DetectorKind | null {
  return detectorId?.startsWith("typesafe-jev-") ? "jev" : null;
}

function add(bucket: UsageBucket, judgment: FinalMessageJudgment | null): void {
  bucket.requests++;
  if (!judgment) { bucket.errors++; return; }
  bucket.inputTokens += judgment.usage.inputTokens ?? 0;
  bucket.outputTokens += judgment.usage.outputTokens ?? 0;
}
function addBucket(target: UsageBucket, delta: UsageBucket): void {
  target.requests += delta.requests; target.errors += delta.errors;
  target.inputTokens += delta.inputTokens; target.outputTokens += delta.outputTokens;
}
interface PendingCount { kind: DetectorKind; day: string; bucket: UsageBucket }

export function createUsageLedger(options: { store: UsageStore; warn(message: string): void; now?: () => number }): UsageLedger {
  const { store, warn } = options;
  const now = options.now ?? Date.now;
  let chain: Promise<unknown> = Promise.resolve();
  // Counts not yet written, by bucket key; `writing` holds the batch a flush is storing.
  const pending = new Map<string, PendingCount>();
  const writing = new Map<string, PendingCount>();
  let timer: NodeJS.Timeout | undefined;
  // Populated on first read, then kept in step with every successful write.
  let cache: { days: Record<DetectorKind, Record<string, UsageBucket>>; inherited: Record<DetectorKind, Record<string, UsageBucket>>; since: string | null } | null = null;
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = chain.catch(() => undefined).then(operation);
    chain = next;
    return next;
  }
  async function read(key: string): Promise<UsageBucket> {
    return bucketSchema.optional().parse(await store.get(key)) ?? empty();
  }
  async function load(): Promise<NonNullable<typeof cache>> {
    const days: Record<DetectorKind, Record<string, UsageBucket>> = { jev: {} };
    for (const key of await store.list(PREFIX)) {
      const match = dayKey.exec(key);
      if (match) days[match[1] as DetectorKind][match[2]!] = await read(key);
    }
    const inherited: Record<DetectorKind, Record<string, UsageBucket>> = { jev: {} };
    for (const key of await store.list(LEGACY_USAGE_PREFIX)) {
      const match = dayKey.exec(key.slice(LEGACY_DATA_PREFIX.length));
      if (match) inherited[match[1] as DetectorKind][match[2]!] = await read(key);
    }
    for (const kind of detectorKinds) for (const [day, bucket] of Object.entries(inherited[kind])) {
      const total = days[kind][day] ?? empty();
      addBucket(total, bucket); days[kind][day] = total;
    }
    const ownSince = z.string().optional().parse(await store.get(MARKER));
    const legacySince = z.string().optional().parse(await store.get(`${LEGACY_USAGE_PREFIX}backfilled`));
    const since = [ownSince, legacySince].filter((day): day is string => day !== undefined).sort()[0] ?? null;
    return { days, inherited, since };
  }
  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    return serial(async () => {
      for (const [key, count] of pending) writing.set(key, count);
      pending.clear();
      for (const [key, { kind, day, bucket: delta }] of writing) {
        try {
          const bucket = await read(key);
          addBucket(bucket, delta);
          await store.set(key, bucket);
          if (cache) {
            const total = { ...bucket };
            const legacy = cache.inherited[kind][day];
            if (legacy) addBucket(total, legacy);
            cache.days[kind][day] = total;
          }
        } catch (cause) {
          warn(`Detector usage not recorded for ${kind} on ${day}: ${cause instanceof Error ? cause.message : String(cause)}`);
        } finally { writing.delete(key); }
      }
    });
  }
  return {
    record(kind, judgment, at = now()) {
      const day = utcDay(at);
      const key = `${PREFIX}${kind}.${day}`;
      const count = pending.get(key) ?? { kind, day, bucket: empty() };
      add(count.bucket, judgment);
      pending.set(key, count);
      if (!timer) {
        timer = setTimeout(() => void flush(), USAGE_FLUSH_MS);
        timer.unref();
      }
    },
    backfill(records) {
      // Live counts reach storage first, so their days show the ledger already started.
      void flush();
      return serial(async () => {
        if (await store.get(MARKER) !== undefined) return;
        const legacy = await store.list(LEGACY_USAGE_PREFIX);
        if (legacy.length) {
          await store.set(MARKER, z.string().optional().parse(await store.get(`${LEGACY_USAGE_PREFIX}backfilled`)) ?? utcDay(now()));
          cache = null; return;
        }
        const existing = (await store.list(PREFIX)).flatMap(key => dayKey.exec(key)?.[2] ?? []).sort();
        // Calls were already being counted live; importing records now would count them twice.
        if (existing.length) { await store.set(MARKER, existing[0]); cache = null; return; }
        const days = new Map<string, UsageBucket>();
        let earliest: number | null = null;
        for (const record of records) {
          const kind = detectorKindOf(record.detector);
          // A judgment proves a completed call; an error without one is a failed call. Other judgment-less records never reached the API or cannot be told apart.
          if (!kind || (!record.judgment && record.action !== "error")) continue;
          const key = `${PREFIX}${kind}.${utcDay(record.observedAt)}`;
          const bucket = days.get(key) ?? empty();
          add(bucket, record.judgment);
          days.set(key, bucket);
          earliest = Math.min(earliest ?? record.observedAt, record.observedAt);
        }
        for (const [key, bucket] of days) await store.set(key, bucket);
        await store.set(MARKER, utcDay(earliest ?? now()));
        cache = null;
      }).catch(cause => warn(`Detector usage backfill failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    },
    async history(kind) {
      try {
        cache ??= await serial(load);
        const days = structuredClone(cache.days[kind]);
        for (const count of [...writing.values(), ...pending.values()]) {
          if (count.kind !== kind) continue;
          const bucket = days[count.day] ?? empty();
          addBucket(bucket, count.bucket);
          days[count.day] = bucket;
        }
        return { days, since: cache.since };
      } catch (cause) {
        warn(`Detector usage unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
    },
    flush,
  };
}

/** Counts every classification call, success or failure; the ledger never delays or fails the call. */
export function meteredDetector(detector: FinalMessageClassifier, kind: DetectorKind, ledger: UsageLedger): FinalMessageClassifier {
  return {
    id: detector.id,
    async classify(finalAssistantMessage, options) {
      let judgment: FinalMessageJudgment | null = null;
      try {
        judgment = await detector.classify(finalAssistantMessage, options);
        return judgment;
      } finally {
        ledger.record(kind, judgment);
      }
    },
  };
}
