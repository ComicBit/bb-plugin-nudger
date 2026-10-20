import { z } from "zod";
import { statsSchema, type NudgerStats } from "./stats.js";

/** The stats on screen and when a read last confirmed them. */
export interface CachedStats { syncedAt: number; stats: NudgerStats }
export type StatsCacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface StatsCache {
  /** The held stats no older than the max age, restored from storage on a cold start; null when there are none. */
  read(now: number): CachedStats | null;
  /** Holds `entry` at once and writes it to storage shortly after. */
  save(entry: CachedStats): void;
  /** Writes a pending entry now; the page calls it when it closes. */
  persist(): void;
}

export const STATS_CACHE_KEY = "nudger:stats-cache-v1";
/** Older stats are dropped rather than shown. */
export const STATS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Reads land about once a second while threads work; storage gets the latest of a burst this long after its first. */
export const STATS_CACHE_WRITE_DELAY_MS = 2_000;
const storedSchema = z.object({ syncedAt: z.number().finite(), stats: statsSchema }).strict();

function browserStorage(): StatsCacheStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function createStatsCache(storage = browserStorage()): StatsCache {
  let held: CachedStats | null = null;
  let restored = false;
  let cancelWrite: (() => void) | null = null;
  function discard() {
    held = null;
    cancelWrite?.();
    cancelWrite = null;
    try { storage?.removeItem(STATS_CACHE_KEY); } catch { /* Storage unavailable; nothing to discard. */ }
  }
  const cache: StatsCache = {
    read(now) {
      if (!restored) {
        restored = true;
        try {
          const raw = storage?.getItem(STATS_CACHE_KEY) ?? null;
          // Stats stored by another Nudger version read as none instead of breaking the page.
          const parsed = raw === null ? null : storedSchema.safeParse(JSON.parse(raw));
          if (parsed?.success) held = parsed.data;
          else if (parsed) discard();
        } catch { discard(); }
      }
      if (held !== null && now - held.syncedAt > STATS_CACHE_MAX_AGE_MS) discard();
      return held;
    },
    save(entry) {
      held = entry;
      restored = true;
      if (storage === null || cancelWrite !== null) return;
      const timer = setTimeout(cache.persist, STATS_CACHE_WRITE_DELAY_MS);
      cancelWrite = () => clearTimeout(timer);
    },
    persist() {
      if (cancelWrite === null) return;
      cancelWrite();
      cancelWrite = null;
      // Quota or privacy-mode failures only cost the next cold start its instant render.
      try { storage?.setItem(STATS_CACHE_KEY, JSON.stringify(held)); } catch { /* Kept in memory for this session. */ }
    },
  };
  return cache;
}
