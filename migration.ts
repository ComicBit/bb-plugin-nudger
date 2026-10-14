import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { migrationSchema, type MigrationPage } from "./nudger-contract.js";
import { LEGACY_ACTIVATION_KEY, LEGACY_DATA_PREFIX, LEGACY_SETTINGS_KEY, type ImportedSettings } from "./migration-storage.js";

export const MIGRATION_KEY = "migration.headquarters.v1";
interface Checkpoint { cursor: string | null; complete: boolean }
export interface MigratableSettings {
  get(): Promise<{ detector?: string; typesafeApiKey?: string }>;
}
export interface MigrationOptions {
  store: BbPluginApi["storage"]["kv"];
  settings: MigratableSettings;
  readPage(cursor: string | null): Promise<MigrationPage>;
  signal?: AbortSignal;
}
/** Copy-only import. Every entry is durable before advancing the checkpoint; retries never add counters twice. */
export async function migrateHeadquarters(options: MigrationOptions): Promise<boolean> {
  const { store, settings } = options;
  const checkpoint = await store.get<Checkpoint>(MIGRATION_KEY);
  if (checkpoint?.complete) return false;
  let cursor = checkpoint?.cursor ?? null;
  const seen = new Set<string>();
  for (;;) {
    options.signal?.throwIfAborted();
    const page = migrationSchema.parse(await options.readPage(cursor));
    // BB standard settings writes do not share our queue and have no CAS. Never write
    // settings during import: the operator explicitly selects a detector and supplies
    // its credential through Nudger's public secret setting. The encrypted source stays intact.
    await settings.get();
    if (await store.get(LEGACY_SETTINGS_KEY) === undefined) {
      await store.set(LEGACY_ACTIVATION_KEY, true);
      await store.set(LEGACY_SETTINGS_KEY, {
        detector: page.settings.detector,
        keyAvailable: !!page.settings.typesafeApiKey,
      } satisfies ImportedSettings);
    }
    for (const entry of page.entries) {
      options.signal?.throwIfAborted();
      const key = `${LEGACY_DATA_PREFIX}${entry.key}`;
      if (await store.get(key) !== undefined) continue;
      let value = entry.value;
      // Import the diagnostic decision, never a live timer. Continuation also rejects legacy plugin submission IDs.
      if (entry.key.startsWith("continuation.nudge.") && value !== null && typeof value === "object" && !Array.isArray(value) && value.state === "pending") {
        value = { ...value, state: "cancelled", cancelReason: "Imported from Headquarters without replaying a pending nudge" };
      }
      await store.set(key, value);
    }
    if (page.nextCursor !== null && (page.nextCursor === cursor || seen.has(page.nextCursor))) throw new Error("Headquarters migration cursor did not advance");
    await store.set(MIGRATION_KEY, { cursor: page.nextCursor, complete: page.nextCursor === null } satisfies Checkpoint);
    if (page.nextCursor === null) return true;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
