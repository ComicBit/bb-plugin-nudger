import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecoveryRecord } from "./recovery-contract.js";
import { boundedRows, historyPage, historyVersion, PAGE_BYTES } from "./publication.js";
import { historySchema } from "./nudger-contract.js";

function record(index: number): RecoveryRecord {
  return { id: String(index).padStart(6, "0"), threadId: "worker", projectId: "project", runId: `run-${index}`, messageId: `message-${index}`, messageRevision: 1,
    observedAt: index * 86_400_000, classification: "continue", action: "nudged", reason: "Continuation scheduled", detector: "typesafe-jev-1.13.0", judgment: null };
}

test("history version changes for same-ID action and judgment changes, but is stable across reads and order", () => {
  const rows = [record(1), record(2)];
  const initial = historyVersion(rows);
  assert.equal(historyVersion([...rows].reverse()), initial);
  assert.equal(historyVersion(structuredClone(rows)), initial);
  rows[0]!.action = "suppressed";
  const changed = historyVersion(rows); assert.notEqual(changed, initial);
  rows[0]!.judgment = { classification: "continue", model: "fixture", latencyMs: 3, usage: { inputTokens: 30, outputTokens: 2, cost: null }, confidence: 1, probabilities: null, questions: null };
  assert.notEqual(historyVersion(rows), changed);
});

test("bounded history pagination returns every retained daily record beyond the snapshot row and byte budgets", () => {
  const records = Array.from({ length: 701 }, (_, index) => ({ ...record(index), reason: "🙂".repeat(3000) }));
  let cursor: string | null = null;
  const read: RecoveryRecord[] = [];
  do {
    const page = historySchema.parse(historyPage(records, cursor));
    assert.ok(page.records.length <= 200);
    assert.ok(Buffer.byteLength(JSON.stringify(page.records)) <= PAGE_BYTES);
    read.push(...page.records); cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(read.length, 701); assert.equal(new Set(read.map(row => row.id)).size, 701);
  assert.equal(read[0]!.observedAt, 0); assert.equal(read.at(-1)!.observedAt, 700 * 86_400_000);
});

test("large blocker text is bounded by the packet budget, not just the row count", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: index, text: "x".repeat(24_576) }));
  const packet = boundedRows(rows);
  assert.ok(packet.length > 0 && packet.length < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= PAGE_BYTES);
});
