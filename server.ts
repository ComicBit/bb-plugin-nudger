import type { BbPluginApi, ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setInterval as every } from "node:timers/promises";
import type { z } from "zod";
import { createContinuation, type Continuation } from "./continuation.js";
import { CANCEL_REASON, JEV_KEY_REJECTED, nudgeRejectMessage } from "./continuation-copy.js";
import { continuationStatus, type ContinuationStatus } from "./continuation-status.js";
import { createRecoveryService } from "./recovery.js";
import type { FinalMessageClassifier, RecoveryBlocker, RecoveryRecord, RecoveryService } from "./recovery-contract.js";
import { createJevDetector, jevBlockerFacts, runShadowComparison, type ShadowComparison } from "./detectors.js";
import { createUsageLedger, meteredDetector, type UsageLedger } from "./detector-usage.js";
import { createRecoveryVerifier } from "./verification.js";
import { createHeadquartersPeer } from "./headquarters.js";
import { migrateHeadquarters, MIGRATION_KEY } from "./migration.js";
import { LEGACY_ACTIVATION_KEY, retainedValue } from "./migration-storage.js";
import { checkJevKey, EMPTY_KEY_STATE, KEY_STATE_KEY, keyChecked, keyFingerprint, type KeyState } from "./jev-key.js";
import { boundedRows, historyPage, historyVersion } from "./publication.js";
import { rpcContract } from "./rpc-contract.js";
import { decisionSchema, labelRequestSchema, snapshotSchema } from "./nudger-contract.js";
import { type NudgerConfiguration } from "./rpc-contract.js";
import { computeStats } from "./stats.js";

const DECISIONS_USAGE = "bb nudger decisions [--since <ISO date|epoch ms>] [--out <path>]";
const LABEL_USAGE = "bb nudger label <recordId> <wrong|clear> [--by <name>] [--note <text>]";

/** `--name value` pairs; null when any token is not one. */
function cliFlags(tokens: readonly string[]): Record<string, string> | null {
  const flags: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index]!, value = tokens[index + 1];
    if (!name.startsWith("--") || value === undefined) return null;
    flags[name.slice(2)] = value;
  }
  return flags;
}

/** Factory registration is synchronous and inert; only the passive background service loads native inventory. */
export default function plugin(bb: BbPluginApi) {
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  // Saving a new key checks it, then sets `detector` and `enabled` (see configure()); explicit values otherwise stay the operator's.
  const settings = bb.settings.define({
    typesafeApiKey: { type: "string", label: "Jev API key", secret: true, description: "Get one at console.typesafe.ai. Saving a new key checks it with Jev and turns Nudger on." },
    enabled: { type: "boolean", label: "Automatic continuation", description: "Send \"please continue\" when Jev judges that an agent stopped with work left. Off: Nudger checks nothing and sends nothing.", default: true },
    detector: { type: "select", label: "Judge", options: ["none", "jev"], experimental_optionLabels: { none: "Off", jev: "Jev" }, default: "none",
      description: "Jev reads only the last reply of a thread that stopped. Saving a key sets this to Jev." },
  });
  const peer = createHeadquartersPeer(bb, signal);
  let recovery: RecoveryService | null = null;
  let continuation: Continuation | null = null;
  let usage: UsageLedger = createUsageLedger({ store: bb.storage.kv, warn: message => bb.log.warn(message) });
  let ready: Promise<void> | null = null;
  let initializing = false;
  let operational = false;
  let configurationError: string | null = null;
  let configuredSignature: string | null = null;
  let settingsRevision = 0;
  let changes: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | null = null;
  let publishTimer: NodeJS.Timeout | undefined;
  let cachedHistory: { records: ReturnType<RecoveryService["records"]>; version: string } | null = null;
  const blockers = new Map<string, RecoveryBlocker>();
  const bannerReads = new Map<string, { at: number; fingerprint: string }>();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = changes.catch(() => undefined).then(operation);
    changes = result;
    return result;
  }
  function requireOperator(context: ExperimentalPluginRpcHandlerContext): void {
    if (context.experimental_caller.kind === "plugin") throw new Error("Only the native operator may change Nudger settings or continuation preferences.");
  }
  function statusFor(threadId: string): ContinuationStatus {
    return continuationStatus({ threadId, now: Date.now(), ownThread: peer.contains(threadId), recovery: recovery?.threadState(threadId) ?? null,
      enabled: continuation?.enabled(threadId) ?? false, nudge: continuation?.latest(threadId) ?? null, nudgeCount: continuation?.sentCount(threadId) ?? 0 });
  }
  const fingerprint = ({ updatedAt: _updatedAt, ...status }: ContinuationStatus) => JSON.stringify(status);
  function changed() {
    cachedHistory = null;
    if (signal.aborted || publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      if (signal.aborted) return;
      bb.realtime.publish("nudger-changed-v1", { version: 1 });
      for (const [threadId, read] of bannerReads) {
        if (Date.now() - read.at > 6 * 60 * 60_000) { bannerReads.delete(threadId); continue; }
        const next = fingerprint(statusFor(threadId));
        if (next !== read.fingerprint) { read.fingerprint = next; bb.realtime.publish("nudger-continuation-changed-v1", { threadId }); }
      }
    }, 1_000);
    publishTimer.unref();
  }
  function history() {
    if (!cachedHistory) {
      const records = recovery?.records() ?? [];
      cachedHistory = { records, version: historyVersion(records) };
    }
    return cachedHistory;
  }
  /** Jev, metered. Each call's outcome also tells whether Jev still accepts the key. */
  function jev(key: string): FinalMessageClassifier {
    const detector = meteredDetector(createJevDetector({ apiKey: key }), "jev", usage);
    const fingerprint = keyFingerprint(key);
    return { id: detector.id, async classify(text, options) {
      try {
        const judgment = await detector.classify(text, options);
        noteKeyResult(fingerprint, "connected");
        return judgment;
      } catch (cause) {
        if (cause instanceof Error && cause.message === JEV_KEY_REJECTED) noteKeyResult(fingerprint, "rejected");
        throw cause;
      }
    } };
  }
  let notedKeyResult: string | null = null;
  /** A live call's verdict on the key. A refused key revokes Jev at once, so no further call uses it. */
  function noteKeyResult(fingerprint: string, result: "connected" | "rejected") {
    if (signal.aborted || notedKeyResult === `${fingerprint}:${result}`) return;
    notedKeyResult = `${fingerprint}:${result}`;
    void serial(async () => {
      const state = await bb.storage.kv.get<KeyState>(KEY_STATE_KEY) ?? EMPTY_KEY_STATE;
      if (state.check?.fingerprint === fingerprint && state.check.result === result) return;
      await bb.storage.kv.set(KEY_STATE_KEY, { ...state, check: { fingerprint, result, at: Date.now(), detail: null } });
      if (result === "rejected") await configure();
      changed();
    }).catch(cause => { if (!signal.aborted) bb.log.warn(`Nudger could not record Jev's answer about the key: ${String(cause)}`); });
  }
  async function configure() {
    const revision = settingsRevision;
    const config = await settings.get();
    if (revision !== settingsRevision) return;
    signal.throwIfAborted();
    const key = config.typesafeApiKey ?? "";
    const fingerprint = key ? keyFingerprint(key) : null;
    let state = await bb.storage.kv.get<KeyState>(KEY_STATE_KEY) ?? EMPTY_KEY_STATE;
    if (fingerprint && state.pending?.fingerprint === fingerprint) {
      const checked = keyChecked(state, { fingerprint, at: Date.now(), ...await checkJevKey(key, { signal }) });
      if (revision !== settingsRevision) return;
      state = checked.state; notedKeyResult = null;
      await bb.storage.kv.set(KEY_STATE_KEY, state);
      changed();
      // A newly saved key that Jev accepts turns Nudger on, whatever was switched off before.
      if (checked.activate) {
        await settings.experimental_set({ detector: "jev", enabled: true });
        // Applied in this same queued step, so anyone awaiting it already sees Nudger on.
        return configure();
      }
    }
    const rejected = state.check?.fingerprint === fingerprint && state.check.result === "rejected";
    const signature = JSON.stringify([config.enabled, config.detector ?? "none", key, rejected]);
    if (configuredSignature === signature && configurationError === null) return;
    operational = false;
    continuation?.cancelAll("Nudger detector or enablement settings changed");
    recovery?.configure(null);
    configurationError = null;
    try {
      const migration = await bb.storage.kv.get<{ complete: boolean }>(MIGRATION_KEY);
      if (!migration?.complete && await bb.storage.kv.get(LEGACY_ACTIVATION_KEY)) throw new Error("Legacy migration is incomplete; observation continues, but imported detector settings wait for pause and per-thread policy restoration.");
      if (revision !== settingsRevision) return;
      if (config.enabled && config.detector === "jev") {
        if (!key) throw new Error("Paste your Jev API key in Nudger settings.");
        if (rejected) throw new Error("Jev rejected this API key. Paste a valid key from console.typesafe.ai.");
        recovery?.configure(jev(key)); operational = true;
      }
    } catch (cause) { configurationError = cause instanceof Error ? cause.message : String(cause); }
    if (revision !== settingsRevision) return;
    configuredSignature = signature;
    changed();
  }
  async function importLegacy(): Promise<boolean> {
    if ((await bb.storage.kv.get<{ complete: boolean }>(MIGRATION_KEY))?.complete || !peer.present()) return false;
    operational = false; configuredSignature = null;
    continuation?.cancelAll("Legacy policy restoration in progress");
    recovery?.configure(null);
    try { return await migrateHeadquarters({ store: bb.storage.kv, settings, readPage: peer.readMigration, signal }); }
    catch (cause) { if (!signal.aborted) bb.log.warn(`Nudger migration deferred: ${cause instanceof Error ? cause.message : String(cause)}`); return false; }
  }
  async function load() {
    signal.throwIfAborted();
    if (continuation) await continuation.dispose();
    if (recovery) await recovery.dispose();
    await usage.flush();
    signal.throwIfAborted();
    blockers.clear(); cachedHistory = null; configuredSignature = null; operational = false;
    usage = createUsageLedger({ store: bb.storage.kv, warn: message => bb.log.warn(message) });
    continuation = createContinuation({ bb, cursor: threadId => recovery?.cursor(threadId) ?? null,
      paused: () => initializing || !operational || (recovery?.status().paused ?? true),
      onChange: threadId => { recovery?.noteNudge(threadId); if (!signal.aborted) bb.realtime.publish("nudger-continuation-changed-v1", { threadId }); } });
    recovery = createRecoveryService({ bb, controlThreadIds: peer.currentControls, detector: null, continuation,
      reportBlocker: async blocker => { blockers.set(blocker.threadId, blocker); changed(); }, onChange: changed });
    await continuation.start();
    await recovery.start();
    signal.throwIfAborted();
    await usage.backfill(recovery.records());
    await configure();
    bb.realtime.publish("nudger-continuation-changed-v1", { threadId: null });
  }
  async function ensureReady() {
    signal.throwIfAborted();
    if (!ready) ready = serial(async () => {
      initializing = true;
      try { await peer.refresh(); await importLegacy(); await load(); }
      finally { initializing = false; }
    }).catch(cause => { ready = null; throw cause; });
    await ready;
  }
  async function configuration(): Promise<NudgerConfiguration> {
    await ensureReady(); await changes;
    const config = await settings.get();
    const state = await bb.storage.kv.get<KeyState>(KEY_STATE_KEY) ?? EMPTY_KEY_STATE;
    const fingerprint = config.typesafeApiKey ? keyFingerprint(config.typesafeApiKey) : null;
    const check = fingerprint && state.check?.fingerprint === fingerprint ? state.check : null;
    return { version: 1 as const, enabled: config.enabled, detector: config.detector === "jev" ? "jev" : "none",
      key: fingerprint ? check?.result ?? "saved" : "missing", keyDetail: check?.detail ?? null,
      active: operational, paused: recovery!.status().paused, error: configurationError };
  }
  // Retained records keep only the final message's identity; its text is read once, from that exact event, and cached.
  const recordedMessages = new Map<string, string | null>();
  async function recordedMessage(record: { threadId: string; messageId: string; messageRevision: number }): Promise<string | null> {
    const key = `${record.threadId}:${record.messageId}:${record.messageRevision}`;
    if (recordedMessages.has(key)) return recordedMessages.get(key)!;
    let text: string | null = null;
    try {
      const [row] = await bb.sdk.threads.events.list({ threadId: record.threadId, afterSeq: String(record.messageRevision - 1), order: "asc", limit: "1", types: ["item/completed"] });
      if (row?.type === "item/completed" && row.seq === record.messageRevision && row.data.item.type === "agentMessage" && row.data.item.id === record.messageId) text = row.data.item.text;
    } catch { return null; }
    if (recordedMessages.size > 2000) recordedMessages.clear();
    recordedMessages.set(key, text);
    return text;
  }
  /**
   * Retained obstacles judged before the `ending`/`consequence` questions existed are judged once more after a reload,
   * from the same recorded final message, so old "decisions" that only reported an operator-chosen state settle. Bounded:
   * a few per read, a fixed number per process, each record at most once, and only while Jev is selected and unpaused.
   */
  const REJUDGE_PER_READ = 5;
  let rejudgeBudget = 25;
  const rejudged = new Set<string>();
  /** Records this read path rebuilt from history (not live reports); only these may still be owed a re-judgment. */
  const restored = new Set<string>();
  async function rejudgeRetained(record: RecoveryRecord, text: string): Promise<RecoveryRecord> {
    if (rejudgeBudget <= 0 || !operational || recovery!.status().paused) return record;
    // Claimed before any await, so concurrent snapshot and stats reads never judge the same ending twice.
    rejudged.add(record.id);
    const config = await settings.get();
    if (!config.enabled || config.detector !== "jev" || !config.typesafeApiKey) { rejudged.delete(record.id); return record; }
    rejudgeBudget--;
    try {
      return await recovery!.rejudge(record.id, await jev(config.typesafeApiKey).classify(text, { signal })) ?? record;
    } catch (cause) {
      if (!signal.aborted) bb.log.warn(`Nudger could not re-judge retained ending ${record.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return record;
    }
  }
  /**
   * Obstacles that current public thread state still confirms. Ones captured by this runtime come first; after a
   * restart, each thread's newest retained obstacle is rebuilt from its exact recorded final message and admitted
   * through the same validation, so a reload never empties Needs your attention. Stale ones are dropped.
   */
  async function liveBlockers(): Promise<RecoveryBlocker[]> {
    await peer.controls();
    const latest = new Map<string, RecoveryRecord>();
    for (const record of history().records) {
      const known = latest.get(record.threadId);
      if (!known || record.observedAt >= known.observedAt) latest.set(record.threadId, record);
    }
    let rejudgesLeft = REJUDGE_PER_READ;
    for (const retained of latest.values()) {
      if (retained.action !== "reported") continue;
      if (retained.classification !== "blocker" && retained.classification !== "permission" && retained.classification !== "uncertainty") continue;
      const stale = !retained.judgment?.questions?.ending && !rejudged.has(retained.id);
      // A published thread keeps its blocker, unless it is this same restored ending still owed its re-judgment
      // (published by a read that ran out of re-judge budget, or while paused). Live reports are never re-judged.
      const shown = blockers.get(retained.threadId);
      if (shown && !(stale && shown.recordId === retained.id && restored.has(retained.id))) continue;
      const text = await recordedMessage(retained);
      if (!text) continue;
      const record = stale && rejudgesLeft-- > 0 ? await rejudgeRetained(retained, text) : retained;
      const kind = record.classification;
      // Another read or a live report may have published this thread while the judgment was awaited.
      const published = blockers.get(record.threadId);
      if (published && published.recordId !== record.id) continue;
      if (record.action !== "reported" || (kind !== "blocker" && kind !== "permission" && kind !== "uncertainty")) { if (published) blockers.delete(record.threadId); continue; }
      restored.add(record.id);
      blockers.set(record.threadId, { recordId: record.id, threadId: record.threadId, projectId: record.projectId, runId: record.runId,
        messageId: record.messageId, messageRevision: record.messageRevision, kind, finalAssistantMessage: text, observedAt: record.observedAt,
        ...jevBlockerFacts(record.judgment?.questions ?? null) });
    }
    const live: RecoveryBlocker[] = [];
    for (const [threadId, blocker] of blockers) {
      try {
        if (!await recovery!.validateBlocker(blocker)) { blockers.delete(threadId); continue; }
        live.push({ ...blocker, finalAssistantMessage: blocker.finalAssistantMessage.slice(0, 24576) });
      } catch { blockers.delete(threadId); }
    }
    return live;
  }
  async function snapshot() {
    await ensureReady();
    const live = await liveBlockers();
    const retained = history();
    const status = recovery!.status();
    if (configurationError) status.gates.push(configurationError);
    const threads = boundedRows(status.threads, 512 * 1024, 20000);
    const projects = boundedRows(status.projects, 128 * 1024, 20000);
    if (threads.length !== status.threads.length || projects.length !== status.projects.length) status.gates.push("Public snapshot inventory exceeds its byte budget; watching still covers the complete native inventory.");
    return snapshotSchema.parse({ version: 1, historyVersion: retained.version, status: { ...status, threads, projects },
      records: boundedRows([...retained.records].sort((a, b) => b.observedAt - a.observedAt).map(record => ({ ...record, reason: record.reason.slice(0, 8192) }))),
      jevUsage: await usage.history("jev"), blockers: boundedRows(live, 256 * 1024) });
  }
  async function stats() {
    await ensureReady();
    const live = await liveBlockers();
    return computeStats({ records: history().records, jevUsage: await usage.history("jev"), status: recovery!.status(), liveBlockers: live, now: Date.now() });
  }
  function banner(threadId: string) {
    const status = statusFor(threadId);
    bannerReads.set(threadId, { at: Date.now(), fingerprint: fingerprint(status) });
    return status;
  }
  bb.experimental_hooks.on("message.dispatch", async context => {
    const owned = context.experimental_submission?.pluginId === bb.pluginId || context.queuedMessages.some(row => row.originPluginId === bb.pluginId);
    if (owned) {
      const controls = await peer.currentControls();
      if (controls.includes(context.thread.id) || peer.contains(context.thread.id)) {
        continuation?.cancel(context.thread.id, "Thread became a Headquarters control conversation");
        return { action: "reject", message: nudgeRejectMessage("thread is a control conversation") };
      }
      if (peer.controlsPending()) return { action: "reject", message: nudgeRejectMessage("Headquarters control identities are being refreshed") };
      if (!continuation || initializing) return { action: "reject", message: nudgeRejectMessage("continuation state is loading") };
    }
    const decision = continuation?.decide(context) ?? (owned
      ? { action: "reject" as const, message: nudgeRejectMessage("unrecognized continuation submission") }
      : { action: "proceed" as const });
    if (decision.action === "proceed" && context.initiator === "user" && context.senderThreadId === null && context.experimental_submission === null) recovery?.rearm(context.thread.id, Date.now());
    return decision;
  });
  function requireNativeOrHeadquarters(context: ExperimentalPluginRpcHandlerContext): void {
    if (context.experimental_caller.kind === "plugin" && context.experimental_caller.pluginId !== "orchestrator") throw new Error("Only native clients and Headquarters may read or label Nudger decisions.");
  }
  async function label({ recordId, label, note, by }: z.infer<typeof labelRequestSchema>) {
    await ensureReady();
    const decision = await recovery!.label(recordId, label === null ? null : { label, note: note ?? null, by, at: Date.now() });
    if (!decision) throw new Error(`Nudger keeps no decision ${recordId}; decisions age out after 30 days.`);
    return { version: 1 as const, decision: decisionSchema.parse(decision) };
  }
  /** Writes every retained decision (observed at or after `since`) to `path` as JSON Lines, oldest first. */
  async function exportDecisions(path: string, since: number | undefined) {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, "w");
    let decisions = 0, bytes = 0, labelled = 0;
    try {
      let cursor: string | null = null;
      do {
        const page = await recovery!.decisions({ cursor, since });
        if (page.decisions.length) {
          const chunk = page.decisions.map(decision => `${JSON.stringify(decisionSchema.parse(decision))}\n`).join("");
          await file.write(chunk);
          decisions += page.decisions.length; bytes += Buffer.byteLength(chunk);
          labelled += page.decisions.filter(decision => decision.label !== null).length;
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
    } finally { await file.close(); }
    return { path, decisions, labelled, bytes };
  }
  bb.rpc.register(rpcContract, {
    nudger_snapshot_v1: snapshot,
    nudger_history_v1: async ({ cursor }) => { await ensureReady(); return historyPage(history().records, cursor); },
    async nudger_pause_v1({ paused }, context) {
      if (context.experimental_caller.kind === "plugin" && context.experimental_caller.pluginId !== "orchestrator") throw new Error("Only Headquarters may forward a plugin pause request.");
      await ensureReady();
      return serial(async () => {
        await recovery!.setPaused(paused);
        if (paused) continuation!.cancelAll(CANCEL_REASON.paused);
        return { version: 1 as const, paused: recovery!.status().paused };
      });
    },
    nudger_continuation_status_v1: async ({ threadId }) => { await ensureReady(); await peer.currentControls(); return banner(threadId); },
    nudger_continuation_cancel_v1: async ({ threadId }, context) => {
      requireOperator(context);
      await ensureReady();
      return serial(async () => { continuation!.cancel(threadId, CANCEL_REASON.countdown); await continuation!.flush(); return banner(threadId); });
    },
    nudger_continuation_toggle_v1: async ({ threadId, enabled }, context) => {
      requireOperator(context);
      await ensureReady();
      return serial(async () => { await bb.sdk.threads.get({ threadId }); await continuation!.setEnabled(threadId, enabled); return banner(threadId); });
    },
    nudger_settings_v1: configuration,
    async nudger_settings_set_v1({ version: _version, ...values }, context) {
      requireOperator(context);
      await ensureReady();
      await serial(async () => { await settings.experimental_set(values); await configure(); });
      return configuration();
    },
    nudger_stats_v1: stats,
    async nudger_decisions_v1({ cursor, since }, context) {
      requireNativeOrHeadquarters(context);
      await ensureReady();
      return { version: 1 as const, ...await recovery!.decisions({ cursor, since }) };
    },
    async nudger_label_v1(request, context) {
      requireNativeOrHeadquarters(context);
      return label(request);
    },
  }, { experimental_discoverable: true });
  const verifier = createRecoveryVerifier({ readShadowComparison: async () => await retainedValue<ShadowComparison>(bb.storage.kv, "detector/synthetic-shadow") ?? null,
    selectedDetectorId: async () => recovery?.status().detectorId ?? null });
  bb.cli.register({ name: "nudger", summary: "Inspect guarded continuation; synthetic validation is explicit and never dispatches project work.", commands: [
    { name: "status", summary: "Read passive inventory, gates and current recovery history.", usage: "bb nudger status" },
    { name: "continuation", summary: "Read counts and continuation state, or toggle one existing thread.", usage: "bb nudger continuation [<threadId> [on|off]]" },
    { name: "decisions", summary: "Export the 30-day decision log as JSONL (read-only); prints the file path and counts.", usage: DECISIONS_USAGE },
    { name: "label", summary: "Mark one decision wrong (or clear it); labelled decisions export as a test set.", usage: LABEL_USAGE },
    { name: "verify", summary: "Validate the stored synthetic Jev validation without a model call.", usage: "bb nudger verify" },
    { name: "shadow", summary: "Explicitly run Jev against the bundled synthetic corpus (paid calls).", usage: "bb nudger shadow --confirm-paid-synthetic" },
  ], async run(args, context) {
    if (args[0] === "status" && args.length === 1) return { exitCode: 0, stdout: JSON.stringify(await snapshot(), null, 2) };
    if (args[0] === "continuation" && args.length <= 3) {
      await ensureReady();
      if (args.length === 1) return { exitCode: 0, stdout: JSON.stringify({ paused: recovery!.status().paused, ...continuation!.snapshot() }, null, 2) };
      const threadId = args[1]!.trim(); await bb.sdk.threads.get({ threadId });
      if (args.length === 3) {
        if (args[2] !== "on" && args[2] !== "off") return { exitCode: 1, stderr: "Usage: bb nudger continuation [<threadId> [on|off]]" };
        await serial(() => continuation!.setEnabled(threadId, args[2] === "on"));
      }
      return { exitCode: 0, stdout: JSON.stringify({ threadId, enabled: continuation!.enabled(threadId), status: statusFor(threadId), ...continuation!.snapshot(threadId) }, null, 2) };
    }
    if (args[0] === "decisions") {
      const flags = cliFlags(args.slice(1));
      const since = flags?.since === undefined ? undefined : /^\d+$/.test(flags.since) ? Number(flags.since) : Date.parse(flags.since);
      if (!flags || Object.keys(flags).some(name => name !== "since" && name !== "out") || Number.isNaN(since)) return { exitCode: 1, stderr: `Usage: ${DECISIONS_USAGE}` };
      await ensureReady();
      const dataDir = bb.server.experimental_dataDir;
      const path = flags.out !== undefined ? resolve(context.cwd ?? dataDir, flags.out)
        : join(dataDir, "plugins", bb.pluginId, "exports", `decisions-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
      return { exitCode: 0, stdout: JSON.stringify(await exportDecisions(path, since), null, 2) };
    }
    if (args[0] === "label" && args.length >= 3) {
      const flags = cliFlags(args.slice(3));
      const request = labelRequestSchema.safeParse({ version: 1, recordId: args[1], label: args[2] === "wrong" ? "wrong" : args[2] === "clear" ? null : undefined,
        note: flags?.note, by: flags?.by ?? "operator" });
      if (!flags || Object.keys(flags).some(name => name !== "by" && name !== "note") || !request.success) return { exitCode: 1, stderr: `Usage: ${LABEL_USAGE}` };
      const { decision } = await label(request.data);
      return { exitCode: 0, stdout: JSON.stringify({ recordId: decision.id, label: decision.label }, null, 2) };
    }
    if (args[0] === "verify" && args.length === 1) { await ensureReady(); return { exitCode: 0, stdout: JSON.stringify(await verifier.validateDetectorComparison(recovery!.status().detectorId ?? "", { signal: context.signal }), null, 2) }; }
    if (args[0] === "shadow" && args.length === 2 && args[1] === "--confirm-paid-synthetic") {
      await ensureReady();
      return serial(async () => {
        const config = await settings.get();
        if (!config.typesafeApiKey) return { exitCode: 1, stderr: "Paste your Jev API key in Nudger settings. No fallback model is used." };
        const comparison = await runShadowComparison({ detectors: [jev(config.typesafeApiKey)], signal: context.signal ? AbortSignal.any([signal, context.signal]) : signal });
        await bb.storage.kv.set("detector/synthetic-shadow", comparison); await usage.flush(); changed();
        return { exitCode: comparison.summaries.some(summary => summary.failures) ? 1 : 0, stdout: JSON.stringify(comparison, null, 2) };
      });
    }
    return { exitCode: !args.length || args.length === 1 && ["--help", "-h"].includes(args[0]!) ? 0 : 1, stdout: "Usage: bb nudger <status|continuation [<threadId> [on|off]]|decisions [--since <date>] [--out <path>]|label <recordId> <wrong|clear>|verify|shadow --confirm-paid-synthetic>" };
  } });
  settings.onChange((next, prev) => {
    settingsRevision++;
    // Native BB writes are already effective when this fires, outside the plugin queue.
    // Revoke the old detector immediately, and fence configure() awaits by revision.
    configuredSignature = null; operational = false;
    continuation?.cancelAll("Nudger detector or enablement settings changed");
    recovery?.configure(null);
    if (signal.aborted) return;
    const saved = next.typesafeApiKey && next.typesafeApiKey !== prev.typesafeApiKey ? next.typesafeApiKey : null;
    void serial(async () => {
      // A saved key is checked next. A new one then turns Nudger on; the key that already did never overrides a later "off".
      if (saved) {
        const state = await bb.storage.kv.get<KeyState>(KEY_STATE_KEY) ?? EMPTY_KEY_STATE;
        const fingerprint = keyFingerprint(saved);
        await bb.storage.kv.set(KEY_STATE_KEY, { ...state, pending: { fingerprint, activate: fingerprint !== state.activated } });
      }
      if (recovery) await configure();
    }).catch(cause => { if (!signal.aborted) bb.log.warn(`Nudger settings refresh failed: ${String(cause)}`); });
  });
  async function close() {
    lifetime.abort(); clearTimeout(publishTimer);
    if (!closing) closing = (async () => {
      operational = false; await changes.catch(() => undefined);
      await continuation?.dispose(); await recovery?.dispose(); await usage.flush(); blockers.clear();
    })();
    await closing;
  }
  bb.onDispose(close);
  bb.background.service("nudger-watcher-v1", { async start(serviceSignal) {
    const stop = () => lifetime.abort();
    if (serviceSignal.aborted) stop(); else serviceSignal.addEventListener("abort", stop, { once: true });
    try {
      await ensureReady();
      for await (const _tick of every(30_000, undefined, { signal, ref: false })) await serial(async () => {
        await peer.refresh();
        initializing = true;
        try { if (await importLegacy()) await load(); }
        finally { initializing = false; }
        await configure(); await recovery!.refresh();
      });
    } catch (cause) { if (!signal.aborted) { bb.log.error(`Nudger watcher stopped: ${cause instanceof Error ? cause.message : String(cause)}`); throw cause; } }
    finally { serviceSignal.removeEventListener("abort", stop); await close(); }
  } });
}
