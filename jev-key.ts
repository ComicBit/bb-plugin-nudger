import { createHash } from "node:crypto";

/**
 * Saving a new Jev key turns Nudger on. The key itself lives only in BB's secret file; Nudger stores a digest of it,
 * which is enough to tell a newly saved key from the one that already turned Nudger on.
 */
export const KEY_STATE_KEY = "jev.key.v1";
export type KeyCheckResult = "connected" | "rejected" | "unreachable";
export interface KeyCheck { fingerprint: string; result: KeyCheckResult; at: number; detail: string | null }
export interface KeyState {
  /** The last saved key that turned Nudger on. Saving that key again never overrides a later "off". */
  activated: string | null;
  /** A saved key still to be checked; `activate` when it is not the key that already turned Nudger on. */
  pending: { fingerprint: string; activate: boolean } | null;
  /** The latest check, of one key: on save, or by a live Jev call. */
  check: KeyCheck | null;
}
export const EMPTY_KEY_STATE: KeyState = { activated: null, pending: null, check: null };

export function keyFingerprint(key: string): string {
  return createHash("sha256").update(`nudger-jev-key-v1:${key}`).digest("hex");
}

/** The state after the pending key's check, and whether that check turns Nudger on. */
export function keyChecked(state: KeyState, check: KeyCheck): { state: KeyState; activate: boolean } {
  const pending = state.pending?.fingerprint === check.fingerprint ? state.pending : null;
  const activate = check.result === "connected" && pending?.activate === true;
  return {
    state: {
      activated: activate ? check.fingerprint : state.activated,
      // Jev could not be reached: the key stays pending, so the next check can still turn Nudger on.
      pending: pending && check.result !== "unreachable" ? null : state.pending,
      check,
    },
    activate,
  };
}

/** One free call: GET /v1/models lists the models a key may use, and answers 401 for a key TypeSafe does not accept. */
export async function checkJevKey(key: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<{ result: KeyCheckResult; detail: string | null }> {
  const timeout = AbortSignal.timeout(10_000);
  try {
    const response = await (options.fetch ?? fetch)("https://api.typesafe.ai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    await response.body?.cancel();
    if (response.ok) return { result: "connected", detail: null };
    if (response.status === 401 || response.status === 403) return { result: "rejected", detail: null };
    return { result: "unreachable", detail: `Jev answered HTTP ${response.status}` };
  } catch (cause) {
    options.signal?.throwIfAborted();
    return { result: "unreachable", detail: timeout.aborted ? "Jev did not answer within 10 seconds" : cause instanceof Error ? cause.message : String(cause) };
  }
}
