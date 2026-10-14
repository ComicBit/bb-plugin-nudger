import assert from "node:assert/strict";
import { test } from "node:test";
import { DECISION_TEXT_CHARS, decodeText, encodeText, planRetention } from "./decision-log.js";
import type { RecoveryRecord } from "./recovery-contract.js";

const DAY_MS = 86_400_000;
function record(id: string, daysAgo: number, now: number): RecoveryRecord {
  return { id, threadId: "thread", projectId: "project", runId: id, messageId: id, messageRevision: 1, observedAt: now - daysAgo * DAY_MS,
    classification: "finished", action: "finished", reason: "fixture", detector: null, judgment: null, gate: "finished", text: { chars: 10, bytes: 1000, truncated: false } };
}

test("the byte cap drops the oldest decisions the history view does not publish, then its own", () => {
  const now = Date.now();
  // 8–12 days old: the newest is the thread's latest and the oldest the coverage anchor; the middle three are log-only.
  const records = [8, 9, 10, 11, 12].map(days => record(`d${days}`, days, now));
  assert.deepEqual([...planRetention(records, () => 1000, now, { count: 10, bytes: 3000 }).drop].sort(), ["d10", "d11"]);
  assert.deepEqual([...planRetention(records, () => 1000, now, { count: 10, bytes: 1000 }).drop].sort(), ["d10", "d11", "d12", "d9"]);
});

test("past the 30-day log a history-view record keeps its metadata but loses its text", () => {
  const now = Date.now();
  const plan = planRetention([record("latest", 40, now)], () => 1500, now);
  assert.deepEqual([...plan.drop], []);
  assert.deepEqual([...plan.dropText], ["latest"]);
});

test("judged text round-trips compressed and is capped like a published obstacle", () => {
  const text = `Résumé ✓ ${"lorem ipsum ".repeat(3000)}`;
  const { value, ref } = encodeText(text);
  assert.equal(decodeText(value), text.slice(0, DECISION_TEXT_CHARS));
  assert.deepEqual({ chars: ref.chars, truncated: ref.truncated }, { chars: DECISION_TEXT_CHARS, truncated: true });
  assert.ok(ref.bytes < DECISION_TEXT_CHARS / 4);
  assert.equal(decodeText({ br: "not brotli" }), null);
  assert.equal(decodeText(undefined), null);
});
