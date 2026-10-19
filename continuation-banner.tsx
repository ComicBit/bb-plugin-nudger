import { useCallback, useEffect, useRef, useState } from "react";
import { useComposer, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./rpc-contract.js";
import type { ContinuationStatus } from "./continuation-status.js";
import { COPY, countdownLine, LINE, type Line, nudgeCountLabel } from "./continuation-copy.js";
import "./continuation-banner.css";

interface Received {
  threadId: string;
  status: ContinuationStatus;
  /** Client time the countdown reaches zero: `sendAt` corrected for the server's clock. */
  deadline: number | null;
}

const TICK_MS = 250;
/** With no announcement after the countdown ends, ask once more so "Nudging…" cannot stick. */
const NUDGING_GRACE_MS = 3_000;

/**
 * One line above a thread's composer: the thread's auto-continue toggle (an eye), then what auto-continue is doing.
 * While it only watches, the eye says it all; during a countdown a thin bar along the composer's top edge drains with the seconds.
 */
export function ContinuationBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const connected = useRealtimeConnectionState() === "connected";
  const [received, setReceived] = useState<Received | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const accept = useCallback((id: string, status: ContinuationStatus) => {
    const receivedAt = Date.now();
    setReceived({ threadId: id, status, deadline: status.sendAt === null ? null : receivedAt + status.sendAt - status.updatedAt });
    setNow(receivedAt);
  }, []);
  // The fetch loop reads the thread at each pass, so a trailing fetch follows a composer that moved threads.
  const thread = useRef(threadId);
  thread.current = threadId;
  // One fetch in flight; announcements arriving meanwhile collapse into one trailing fetch.
  const live = useRef({ running: false, again: false });
  const refresh = useCallback(async () => {
    if (live.current.running) { live.current.again = true; return; }
    live.current.running = true;
    try {
      do {
        live.current.again = false;
        const id = thread.current;
        if (id === null) return;
        const sequence = ++request.current;
        // A failed read keeps the last status; the next announcement, run change or reconnect retries.
        const status = await rpc.call("nudger_continuation_status_v1", { threadId: id }).catch(() => null);
        if (status && sequence === request.current) accept(id, status);
      } while (live.current.again);
    } finally { live.current.running = false; }
  }, [rpc, accept]);
  useEffect(() => () => { request.current++; }, []);
  // Thread switches, run start/stop (visible here before recovery announces it) and reconnects all refetch.
  useEffect(() => { void refresh(); }, [refresh, threadId, connected, composer.isRunning]);
  useRealtime("nudger-continuation-changed-v1", payload => {
    const change = typeof payload === "object" && payload !== null && "threadId" in payload ? payload : null;
    const target = change?.threadId ?? null;
    if (target === null || target === threadId) void refresh();
  });
  const current = received?.threadId === threadId ? received : null;
  const deadline = current?.status.state === "countdown" ? current.deadline : null;
  useEffect(() => {
    if (deadline === null) return;
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    const recheck = setTimeout(() => { void refresh(); }, Math.max(0, deadline - Date.now()) + NUDGING_GRACE_MS);
    return () => { clearInterval(tick); clearTimeout(recheck); };
  }, [deadline, refresh]);
  if (threadId === null || !current || current.status.state === "hidden") return null;
  const { status } = current;
  const on = status.state !== "off";
  // A failed change keeps the toggle and countdown as they were; a fresh read shows the truth.
  const change = async (call: () => Promise<ContinuationStatus>) => {
    if (busy) return;
    setBusy(true);
    const sequence = ++request.current;
    try {
      const next = await call();
      if (sequence === request.current) accept(threadId, next);
    } catch { void refresh(); }
    finally { setBusy(false); }
  };

  const counting = on && status.state === "countdown" && deadline !== null;
  const remaining = counting ? Math.max(0, deadline - now) : 0;
  const nudging = counting && remaining === 0;
  const fraction = counting && status.totalMs ? Math.min(1, remaining / status.totalMs) : 0;
  // Watching needs no words: the open eye already says it. A waiting line's detail (its step count) updates in place.
  const shown: Shown | null = counting
    ? nudging ? { key: "nudging", line: LINE.nudging } : { key: "countdown", line: countdownLine(Math.ceil(remaining / 1_000), status.checkIn) }
    : on && status.state !== "watching" && status.text !== null
      ? { key: `${status.state}:${status.text}${status.state === "waiting" ? "" : `:${status.detail ?? ""}`}`, line: { text: status.text, detail: status.detail } }
      : null;
  // The ticking text is hidden from screen readers; they hear the countdown once, then "Continuing…".
  const announced = counting ? nudging ? LINE.nudging : countdownLine(Math.ceil((status.sendAt! - status.updatedAt) / 1_000), status.checkIn) : shown?.line ?? null;
  // `data-lg-dock-ui`: Liquid Glass (community plugin) folds composer cards into tap-to-open pills on phones.
  // This line is the composer's own status, not a card, so it uses Liquid Glass's own-UI marker to stay in place.
  return <div className="nudger-cb" data-state={counting ? "countdown" : status.state} data-lg-dock-ui="">
    <span className="nudger-cb-bar" aria-hidden="true"><span style={{ transform: `scaleX(${fraction})` }} /></span>
    <button type="button" className="nudger-cb-toggle" aria-pressed={on} aria-label={on ? COPY.toggleOn : COPY.toggleOff}
      title={on ? COPY.toggleOn : COPY.toggleOff} disabled={busy}
      onClick={() => { void change(() => rpc.call("nudger_continuation_toggle_v1", { threadId, enabled: !on })); }}>
      <Eye />
    </button>
    <LineSwap shown={shown} />
    <span className="nudger-cb-sr" role="status" aria-live="polite">{announced && <LineText line={announced} />}</span>
    {counting && !nudging && <button type="button" className="nudger-cb-cancel" disabled={busy}
      onClick={() => { void change(() => rpc.call("nudger_continuation_cancel_v1", { threadId })); }}>{COPY.cancel}</button>}
    {status.nudgeCount > 0 && <span className="nudger-cb-count" role="img" aria-label={nudgeCountLabel(status.nudgeCount)} title={nudgeCountLabel(status.nudgeCount)}>
      <span key={status.nudgeCount} className="nudger-cb-count-value" aria-hidden="true">{status.nudgeCount}</span>
      <Hand />
    </span>}
  </div>;
}

// Glyph: lucide-static 1.53.0 `hand`, ISC (lucide-LICENSE.txt).
function Hand() {
  return <svg className="nudger-cb-hand" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
    <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
    <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
  </svg>;
}

// Glyphs: lucide-static 1.53.0 `eye` and `eye-closed`, ISC (lucide-LICENSE.txt).
/** Open while the toggle is pressed, closed otherwise; CSS crossfades the two glyphs (with a short lid motion) from `aria-pressed`. */
function Eye() {
  return <svg className="nudger-cb-eye" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <g className="nudger-cb-eye-open">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </g>
    <g className="nudger-cb-eye-closed">
      <path d="m15 18-.722-3.25" />
      <path d="M2 8a10.645 10.645 0 0 0 20 0" />
      <path d="m20 15-1.726-2.05" />
      <path d="m4 15 1.726-2.05" />
      <path d="m9 18 .722-3.25" />
    </g>
  </svg>;
}

function LineText({ line }: { line: Line }) {
  return <>{line.text}{line.detail !== null && <> <span className="nudger-cb-detail">{line.detail}</span></>}</>;
}

/** A line and the identity it animates by: a new key slides in, the old one slides out; the same key just updates. */
interface Shown { key: string; line: Line }
interface Entry extends Shown { id: number; leaving: boolean }

/** Longest an outgoing line stays mounted when its `transitionend` never arrives (reduced motion, hidden tab). */
const EXIT_FALLBACK_MS = 250;

/** Keyed presence for the banner's line: the outgoing line stays mounted, absolutely placed, until its exit transition ends. */
function LineSwap({ shown }: { shown: Shown | null }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const present = entries.find(entry => !entry.leaving) ?? null;
  // Adjusting state while rendering: React re-renders before committing, so no frame shows the stale line.
  if ((present?.key ?? null) !== (shown?.key ?? null)) {
    setEntries(list => {
      const id = (list.at(-1)?.id ?? 0) + 1;
      const kept = list.map(entry => entry.leaving ? entry : { ...entry, leaving: true });
      return shown ? [...kept, { ...shown, id, leaving: false }] : kept;
    });
  } else if (present && shown && (present.line.text !== shown.line.text || present.line.detail !== shown.line.detail)) {
    // Same key, new words (countdown seconds): update in place without re-animating.
    setEntries(list => list.map(entry => entry.id === present.id ? { ...entry, line: shown.line } : entry));
  }
  const remove = useCallback((id: number) => setEntries(list => list.filter(entry => entry.id !== id)), []);
  return <span className="nudger-cb-lines" aria-hidden="true">
    {entries.map(entry => <LineItem key={entry.id} entry={entry} remove={remove} />)}
  </span>;
}

function LineItem({ entry, remove }: { entry: Entry; remove: (id: number) => void }) {
  const { id, leaving } = entry;
  useEffect(() => {
    if (!leaving) return;
    const fallback = setTimeout(() => remove(id), EXIT_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [leaving, id, remove]);
  return <span className="nudger-cb-text" data-leaving={leaving || undefined}
    onTransitionEnd={event => { if (leaving && event.target === event.currentTarget) remove(id); }}>
    <LineText line={entry.line} />
  </span>;
}
