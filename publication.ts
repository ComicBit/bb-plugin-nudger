import { createHash } from "node:crypto";
import type { RecoveryRecord } from "./recovery-contract.js";

export const PAGE_BYTES = 256 * 1024;
export function boundedRows<T>(rows: readonly T[], budget = PAGE_BYTES, limit = 200): T[] {
  const result: T[] = [];
  let bytes = 2;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (result.length === limit || bytes + size > budget) break;
    result.push(row); bytes += size;
  }
  return result;
}
/** Cursor follows a stable record ID, with sorted IDs so pruning does not shift offsets between pages. */
export function historyPage(records: readonly RecoveryRecord[], cursor: string | null) {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const eligible = cursor === null ? sorted : sorted.filter(record => record.id.localeCompare(cursor) > 0);
  const page = boundedRows(eligible.map(record => ({ ...record, reason: record.reason.slice(0, 8192) })));
  if (eligible.length && !page.length) throw new Error("A retained recovery record exceeds the public history page budget");
  return { version: 1 as const, records: page, nextCursor: page.length < eligible.length ? page.at(-1)!.id : null };
}
/** Includes actions/judgments, not only IDs: a classification finishing changes the version. */
export function historyVersion(records: readonly RecoveryRecord[]): string {
  const hash = createHash("sha256");
  for (const record of [...records].sort((a, b) => a.id.localeCompare(b.id))) hash.update(JSON.stringify(record));
  return hash.digest("hex");
}
