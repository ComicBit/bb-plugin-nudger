import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ContinuationStatus } from "./continuation-status.js";
import { decisionsRequestSchema, decisionsSchema, historyRequestSchema, historySchema, labelRequestSchema, labelSchema, pauseSchema, snapshotSchema, versionSchema } from "./nudger-contract.js";
import { statsSchema } from "./stats.js";

const threadSchema = z.object({ threadId: z.string().min(1).max(4096) }).strict();
const continuationStatusSchema: z.ZodType<ContinuationStatus> = z.object({
  state: z.enum(["hidden", "off", "watching", "waiting", "assessing", "countdown", "sent", "skipped"]),
  sendAt: z.number().nullable(), totalMs: z.number().nullable(), checkIn: z.boolean(), text: z.string().max(8192).nullable(), detail: z.string().max(8192).nullable(), updatedAt: z.number(), nudgeCount: z.number().int().nonnegative(),
}).strict();
export const detectors = ["none", "jev"] as const;
/** `key`: none saved, saved but not checked yet, accepted, refused by Jev, or not checkable right now (`keyDetail` says why). */
export const configurationSchema = z.object({ version: z.literal(1), enabled: z.boolean(), detector: z.enum(detectors), key: z.enum(["missing", "saved", "connected", "rejected", "unreachable"]),
  keyDetail: z.string().nullable(), active: z.boolean(), paused: z.boolean(), error: z.string().nullable() });
export type NudgerConfiguration = z.infer<typeof configurationSchema>;
export const rpcContract = defineRpcContract({
  nudger_snapshot_v1: { input: versionSchema, output: snapshotSchema },
  nudger_history_v1: { input: historyRequestSchema, output: historySchema },
  nudger_pause_v1: { input: pauseSchema, output: pauseSchema },
  nudger_continuation_status_v1: { input: threadSchema, output: continuationStatusSchema },
  nudger_continuation_cancel_v1: { input: threadSchema, output: continuationStatusSchema },
  nudger_continuation_toggle_v1: { input: threadSchema.extend({ enabled: z.boolean() }), output: continuationStatusSchema },
  nudger_settings_v1: { input: versionSchema, output: configurationSchema },
  nudger_settings_set_v1: { input: z.object({ version: z.literal(1), enabled: z.boolean().optional(), detector: z.enum(detectors).optional(), typesafeApiKey: z.string().max(8192).optional() }).strict(), output: configurationSchema },
  nudger_stats_v1: { input: versionSchema, output: statsSchema },
  nudger_decisions_v1: { input: decisionsRequestSchema, output: decisionsSchema },
  nudger_label_v1: { input: labelRequestSchema, output: labelSchema },
});
