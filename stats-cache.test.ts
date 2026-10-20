import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStats } from "./stats.js";
import { createStatsCache, STATS_CACHE_KEY, STATS_CACHE_MAX_AGE_MS, STATS_CACHE_WRITE_DELAY_MS, type CachedStats, type StatsCacheStorage } from "./stats-cache.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
function entry(syncedAt: number): CachedStats {
  return { syncedAt, stats: computeStats({ records: [], jevUsage: { days: {}, since: "2026-10-08" }, status: { startedAt: NOW, threads: [], projects: [] }, liveBlockers: [], now: syncedAt }) };
}
function memoryStorage(initial: Record<string, string> = {}): StatsCacheStorage & { items: Map<string, string>; writes: string[] } {
  const items = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    items, writes,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); writes.push(value); },
    removeItem: key => { items.delete(key); },
  };
}

test("a cold start opens on the stored stats; stats past the max age or from another Nudger version read as none and are dropped", () => {
  const stored = entry(NOW - 60_000);
  assert.deepEqual(createStatsCache(memoryStorage({ [STATS_CACHE_KEY]: JSON.stringify(stored) })).read(NOW), stored);
  for (const raw of [JSON.stringify(entry(NOW - STATS_CACHE_MAX_AGE_MS - 1)), JSON.stringify({ syncedAt: NOW, stats: { version: 2 } }), "{not json"]) {
    const storage = memoryStorage({ [STATS_CACHE_KEY]: raw });
    assert.equal(createStatsCache(storage).read(NOW), null, raw.slice(0, 40));
    assert.equal(storage.items.has(STATS_CACHE_KEY), false);
  }
});

test("a burst of reads reaches storage once, as the latest; closing the page writes a pending one at once", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const storage = memoryStorage();
  const cache = createStatsCache(storage);
  const first = entry(NOW), second = entry(NOW + 1_000), third = entry(NOW + 5_000);
  cache.save(first); cache.save(second);
  // In memory at once: the next visit in this session opens on it.
  assert.equal(cache.read(NOW + 1_000), second);
  t.mock.timers.tick(STATS_CACHE_WRITE_DELAY_MS - 1);
  assert.equal(storage.writes.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(storage.writes.map(value => JSON.parse(value)), [second]);
  cache.save(third); cache.persist();
  t.mock.timers.tick(STATS_CACHE_WRITE_DELAY_MS);
  assert.deepEqual(storage.writes.map(value => JSON.parse(value)), [second, third]);
  assert.deepEqual(createStatsCache(storage).read(NOW + 5_000), third);
});
