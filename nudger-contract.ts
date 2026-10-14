import { z } from "zod";

/** Public v1 protocol: portable, bounded, and independent of either plugin's runtime. */
const id = z.string().min(1).max(4096);
const text = z.string().max(8192);
const count = z.number().int().nonnegative();
const timestamp = z.number().finite().min(0).max(8_640_000_000_000_000);
const classification = z.enum(["continue", "finished", "blocker", "permission", "uncertainty"]);
const probabilities = z.record(z.string().max(200), z.number()).refine(value => Object.keys(value).length <= 32);
export const judgmentSchema = z.object({
  classification, model: z.string().max(200), latencyMs: z.number().nonnegative(),
  usage: z.object({ inputTokens: count.nullable(), outputTokens: count.nullable(), cost: z.object({ amount: z.number(), currency: z.string().max(16) }).nullable() }),
  confidence: z.number().nullable(), probabilities: probabilities.nullable(),
  questions: z.record(z.string().max(200), z.object({ choice: z.string().max(200), confidence: z.number(), probabilities })).refine(value => Object.keys(value).length <= 32).nullable(),
});
export const recordSchema = z.object({
  id, threadId: id, projectId: id, runId: id, messageId: id, messageRevision: count, observedAt: timestamp,
  classification: classification.nullable(), action: z.enum(["observed", "finished", "reported", "suppressed", "nudged", "discarded", "error"]),
  reason: text, detector: z.string().max(200).nullable(), judgment: judgmentSchema.nullable(),
});
export const blockerSchema = z.object({
  recordId: id, threadId: id, projectId: id, runId: id, messageId: id, messageRevision: count,
  kind: z.enum(["blocker", "permission", "uncertainty"]), finalAssistantMessage: z.string().max(24576), observedAt: timestamp,
});
export const statusSchema = z.object({
  enabled: z.boolean(), observing: z.boolean(), classifying: z.boolean(), paused: z.boolean(), detectorId: z.string().max(200).nullable(),
  gates: z.array(text).max(32), startedAt: timestamp.nullable(), lastObservedAt: timestamp.nullable(),
  threads: z.array(z.object({ id, projectId: id, title: text.nullable(), status: z.string().max(100), hostId: id.nullable(), visibility: z.string().max(100), parentThreadId: id.nullable(), watched: z.boolean(), exclusion: text.nullable() })).max(20000),
  projects: z.array(z.object({ id, name: text })).max(20000), watchedCount: count, error: text.nullable(),
});
export const usageHistorySchema = z.object({
  days: z.record(z.iso.date(), z.object({ requests: count, errors: count, inputTokens: count, outputTokens: count })).refine(value => Object.keys(value).length <= 3660),
  since: z.iso.date().nullable(),
});
export const snapshotSchema = z.object({ version: z.literal(1), historyVersion: z.string().max(128), status: statusSchema, records: z.array(recordSchema).max(200), jevUsage: usageHistorySchema.nullable(), blockers: z.array(blockerSchema).max(200) });
export const controlThreadsSchema = z.object({ version: z.literal(1), threadIds: z.array(id).max(20000) });
export const pauseSchema = z.object({ version: z.literal(1), paused: z.boolean() });
export const versionSchema = z.object({ version: z.literal(1) });
export const historyRequestSchema = z.object({ version: z.literal(1), cursor: id.nullable().default(null) });
export const historySchema = z.object({ version: z.literal(1), records: z.array(recordSchema).max(200), nextCursor: id.nullable() });
export const migrationKeySchema = z.string().max(4096).regex(/^(?:continuation\.(?:off\.|nudge\.|log$|sentCounts$)|recovery\.(?:records\.|stopped\.|rearmed\.|paused$)|usage\.detector\.|detector\/synthetic-shadow$)/);
// Headquarters' export still carries its former detector choices ("luna", hostId); Nudger keeps them readable but never acts on them.
export const migrationSettingsSchema = z.object({ detector: z.enum(["none", "luna", "jev"]).optional(), typesafeApiKey: z.string().max(8192).optional(), hostId: z.string().max(4096).optional() });
export const migrationRequestSchema = z.object({ version: z.literal(1), cursor: id.nullable().default(null) });
export const migrationSchema = z.object({
  version: z.literal(1), entries: z.array(z.object({ key: migrationKeySchema, value: z.json().refine(value => JSON.stringify(value).length <= 262144) })).max(200),
  settings: migrationSettingsSchema, nextCursor: id.nullable(),
});
export type NudgerSnapshot = z.infer<typeof snapshotSchema>;
export type MigrationPage = z.infer<typeof migrationSchema>;
export type NudgerRecord = NudgerSnapshot["records"][number];
export type NudgerStatus = NudgerSnapshot["status"];
export type NudgerBlocker = NudgerSnapshot["blockers"][number];
export type NudgerUsageHistory = NonNullable<NudgerSnapshot["jevUsage"]>;
