import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";

type Kv = Pick<BbPluginApi["storage"]["kv"], "set" | "delete">;
/** Fingerprint of an absent key. */
const ABSENT = "";
function fingerprint(value: unknown): string {
  return value === undefined ? ABSENT : createHash("sha256").update(JSON.stringify(value)).digest("base64");
}

/**
 * KV writes that skip what storage is already known to hold: each key keeps the fingerprint of the
 * last value this process wrote, deleted or read for it. Callers keep their own writes to a key in order.
 */
export interface KvWriter {
  /** Writes unless the stored value is known to be equal; resolves whether it wrote. */
  set(key: string, value: unknown): Promise<boolean>;
  /** Deletes unless the key is known to be absent; resolves whether it deleted. */
  delete(key: string): Promise<boolean>;
  /** Records what storage holds for `key` as read at load; `undefined` means absent. */
  remember(key: string, value: unknown): void;
}

export function createKvWriter(kv: Kv): KvWriter {
  const known = new Map<string, string>();
  async function apply(key: string, next: string, write: () => Promise<void>): Promise<boolean> {
    if (known.get(key) === next) return false;
    known.set(key, next);
    // A failed write leaves the stored value unknown, so the next write of any value goes through.
    try { await write(); } catch (caught) { known.delete(key); throw caught; }
    return true;
  }
  return {
    set: (key, value) => apply(key, fingerprint(value), () => kv.set(key, value)),
    delete: key => apply(key, ABSENT, () => kv.delete(key)),
    remember(key, value) { known.set(key, fingerprint(value)); },
  };
}
