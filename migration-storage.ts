import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Immutable imported state is a baseline; explicit Nudger values always take precedence. */
export const LEGACY_DATA_PREFIX = "migration.headquarters.data.v1.";
export const LEGACY_SENT_KEY = `${LEGACY_DATA_PREFIX}continuation.sentCounts`;
export const LEGACY_USAGE_PREFIX = `${LEGACY_DATA_PREFIX}usage.detector.`;
export const LEGACY_ACTIVATION_KEY = "migration.headquarters.activation.v1";
export const LEGACY_SETTINGS_KEY = "migration.headquarters.settings.v1";
/** Nonsecret setup information only, kept as imported; it never selects anything. */
export interface ImportedSettings {
  detector?: "none" | "luna" | "jev";
  keyAvailable: boolean;
}

export async function retainedValue<T>(store: BbPluginApi["storage"]["kv"], key: string): Promise<T | undefined> {
  const own = await store.get<T>(key);
  return own === undefined ? store.get<T>(`${LEGACY_DATA_PREFIX}${key}`) : own;
}

/** Logical keys, with each own row shadowing the immutable imported row of the same name. */
export async function retainedKeys(store: BbPluginApi["storage"]["kv"], prefix: string): Promise<string[]> {
  const [own, imported] = await Promise.all([store.list(prefix), store.list(`${LEGACY_DATA_PREFIX}${prefix}`)]);
  return [...new Set([...own, ...imported.map(key => key.slice(LEGACY_DATA_PREFIX.length))])];
}
