import assert from "node:assert/strict";
import { test } from "node:test";
import { blockerSchema, recordSchema, statusSchema, usageHistorySchema } from "./nudger-contract.js";

const record = { id: "record", threadId: "thread", projectId: "project", runId: "run", messageId: "message", messageRevision: 1, observedAt: 0,
  classification: "finished", action: "finished", reason: "Finished", detector: null, judgment: null };
const status = { enabled: false, observing: true, classifying: false, paused: false, detectorId: null, gates: [], startedAt: 0, lastObservedAt: 0, threads: [], projects: [], watchedCount: 0, error: null };
const blocker = { recordId: "record", threadId: "thread", projectId: "project", runId: "run", messageId: "message", messageRevision: 1, kind: "blocker", finalAssistantMessage: "Credential unavailable", observedAt: 0 };

test("public timestamps preserve milliseconds and reject finite numbers outside JavaScript Date range", () => {
  const now = 1_791_849_600_123;
  assert.equal(recordSchema.parse({ ...record, observedAt: now }).observedAt, now);
  assert.equal(blockerSchema.parse({ ...blocker, observedAt: now }).observedAt, now);
  for (const value of [-1, NaN, Infinity, 1e100, 8_640_000_000_000_001]) {
    assert.equal(recordSchema.safeParse({ ...record, observedAt: value }).success, false);
    assert.equal(blockerSchema.safeParse({ ...blocker, observedAt: value }).success, false);
    assert.equal(statusSchema.safeParse({ ...status, startedAt: value }).success, false);
    assert.equal(statusSchema.safeParse({ ...status, lastObservedAt: value }).success, false);
  }
});

test("public usage day keys must be real ISO calendar dates", () => {
  const bucket = { requests: 1, errors: 0, inputTokens: 10, outputTokens: 1 };
  assert.equal(usageHistorySchema.safeParse({ since: "2026-10-01", days: { "2026-10-01": bucket } }).success, true);
  assert.equal(usageHistorySchema.safeParse({ since: "2026-99-01", days: {} }).success, false);
  assert.equal(usageHistorySchema.safeParse({ since: null, days: { "2026-99-01": bucket } }).success, false);
});
