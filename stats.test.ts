import assert from "node:assert/strict";
import { test } from "node:test";
import { JEV_NO_CREDITS, LINE } from "./continuation-copy.js";
import type { RecoveryBlocker, RecoveryInventoryThread, RecoveryRecord } from "./recovery-contract.js";
import { computeStats, statsSchema, type StatsInput } from "./stats.js";

// Thursday; the current ISO week starts Monday 2026-10-05.
const NOW = Date.parse("2026-10-08T12:00:00Z");
const at = (iso: string) => Date.parse(iso);
function record(id: string, observedAt: number, overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return { id, threadId: "thread-a", projectId: "project", runId: id, messageId: `${id}-message`, messageRevision: 1, observedAt, classification: "continue", action: "nudged",
    reason: "Scheduled", detector: "typesafe-jev-1.13.0", judgment: null, ...overrides };
}
function thread(id: string, title: string | null = `Title ${id}`): RecoveryInventoryThread {
  return { id, projectId: "project", title, status: "idle", hostId: null, visibility: "visible", parentThreadId: null, watched: false, exclusion: null };
}
function input(overrides: Partial<StatsInput> = {}): StatsInput {
  return { records: [], jevUsage: { days: {}, since: "2026-10-08" }, status: { startedAt: NOW, threads: [], projects: [{ id: "project", name: "Fixture project" }] }, liveBlockers: [], now: NOW, ...overrides };
}

test("nudges aggregate per UTC day, ISO week and calendar month; periods before the first retained record are uncovered", () => {
  const records = [
    record("a", at("2026-10-08T01:00:00Z")), record("b", at("2026-10-08T23:00:00Z")), record("c", at("2026-10-07T12:00:00Z")),
    record("d", at("2026-09-25T00:00:00Z")), record("e", at("2026-09-24T23:59:59Z")),
    record("first", at("2026-09-20T10:00:00Z"), { action: "finished", classification: "finished" }),
    record("cancelled", at("2026-10-08T02:00:00Z"), { action: "suppressed" }),
  ];
  const stats = statsSchema.parse(computeStats(input({ records })));
  const { day, week, month } = stats.nudges.series;
  assert.equal(stats.nudges.coverageStart, "2026-09-20");
  assert.deepEqual([day[0], day.at(-2), day.at(-1)], [
    { start: "2026-09-25", covered: true, nudges: 1 }, { start: "2026-10-07", covered: true, nudges: 1 }, { start: "2026-10-08", covered: true, nudges: 2 },
  ]);
  assert.equal(day.reduce((sum, point) => sum + point.nudges, 0), 4);
  assert.deepEqual(week.slice(-5), [
    { start: "2026-09-07", covered: false, nudges: 0 }, { start: "2026-09-14", covered: true, nudges: 0 },
    { start: "2026-09-21", covered: true, nudges: 2 }, { start: "2026-09-28", covered: true, nudges: 0 }, { start: "2026-10-05", covered: true, nudges: 3 },
  ]);
  assert.deepEqual(month.map(point => [point.start, point.covered, point.nudges]), [
    ["2026-05-01", false, 0], ["2026-06-01", false, 0], ["2026-07-01", false, 0], ["2026-08-01", false, 0], ["2026-09-01", true, 2], ["2026-10-01", true, 3],
  ]);
  assert.deepEqual(stats.nudges.recent.map(nudge => nudge.recordId), ["b", "a", "c", "d", "e"]);
  // Unknown threads fall back to their id.
  assert.equal(stats.nudges.recent[0]!.title, "thread-a");
});

test("Jev usage is priced from input tokens only, honours the ledger's first day and reports out-of-credits from the newest Jev ending", () => {
  const jevUsage = { since: "2026-10-01", days: {
    "2026-10-08": { requests: 3, errors: 1, inputTokens: 1_000_000, outputTokens: 900_000 },
    "2026-10-01": { requests: 1, errors: 0, inputTokens: 500_000, outputTokens: 10 },
  } };
  const failed = record("failed", at("2026-10-08T10:00:00Z"), { action: "error", classification: null, reason: `Final-message classification/reporting failed: ${JEV_NO_CREDITS}` });
  const stats = statsSchema.parse(computeStats(input({ jevUsage, records: [failed, record("older", at("2026-10-07T10:00:00Z"), { action: "finished", judgment: null })] })));
  const { day, week } = stats.jev!.series;
  assert.deepEqual(day.map(point => point.covered), [false, false, false, false, false, false, true, true, true, true, true, true, true, true]);
  assert.deepEqual(day.at(-1), { start: "2026-10-08", covered: true, requests: 3, errors: 1, inputTokens: 1_000_000, outputTokens: 900_000, costUsd: 0.042 });
  assert.deepEqual(week.at(-1), { start: "2026-10-05", covered: true, requests: 3, errors: 1, inputTokens: 1_000_000, outputTokens: 900_000, costUsd: 0.042 });
  // The week of Sep 28 ends inside coverage and holds Oct 1.
  assert.deepEqual([week.at(-2)!.covered, week.at(-2)!.costUsd], [true, 0.021]);
  assert.equal(stats.jev!.outOfCredits, true);
  assert.equal(stats.jev!.usdPerMillionInputTokens, 0.042);
  const recovered = computeStats(input({ jevUsage, records: [failed, record("later", at("2026-10-08T11:00:00Z"), { action: "finished", judgment: { classification: "finished", model: "jev-1.13.0", latencyMs: 1, usage: { inputTokens: 5, outputTokens: 0, cost: null }, confidence: 1, probabilities: null, questions: null } })] }));
  assert.equal(recovered.jev!.outOfCredits, false);
  assert.equal(computeStats(input({ jevUsage: null })).jev, null);
});

test("needs attention lists each confirmed obstacle once, newest first, with a readable one-line summary", () => {
  const blocker = (threadId: string, observedAt: number, finalAssistantMessage: string, kind: RecoveryBlocker["kind"] = "blocker"): RecoveryBlocker =>
    ({ recordId: `${threadId}-reported`, threadId, projectId: "project", runId: "run", messageId: "message", messageRevision: 1, kind, finalAssistantMessage, observedAt });
  const status = { startedAt: NOW, threads: ["thread-b", "thread-c"].map(id => thread(id)), projects: [{ id: "project", name: "Fixture project" }] };
  const stats = statsSchema.parse(computeStats(input({ status, liveBlockers: [
    blocker("thread-b", at("2026-10-08T05:00:00Z"), "```\ncode only\n```", "permission"),
    blocker("thread-c", at("2026-10-08T09:00:00Z"), "## Status\n**Deploy key** is missing, so the release cannot continue. Details follow."),
  ] })));
  assert.deepEqual(stats.attention, [
    { id: "thread-c-reported", threadId: "thread-c", projectId: "project", title: "Title thread-c", project: "Fixture project", kind: "blocker", observedAt: at("2026-10-08T09:00:00Z"), summary: "Status Deploy key is missing, so the release cannot continue." },
    { id: "thread-b-reported", threadId: "thread-b", projectId: "project", title: "Title thread-b", project: "Fixture project", kind: "permission", observedAt: at("2026-10-08T05:00:00Z"), summary: LINE.permission.text },
  ]);
  assert.deepEqual(computeStats(input()).attention, []);
});
