import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { ContinuationBanner } from "./continuation-banner.js";
import type { rpcContract } from "./rpc-contract.js";
import type { NudgerSnapshot } from "./nudger-contract.js";
import type { z } from "zod";
import type { configurationSchema } from "./rpc-contract.js";
import { NudgerStatsPage } from "./stats-page.js";
import { BUTTON } from "./ui.js";

type Configuration = z.infer<typeof configurationSchema>;
function SettingRow({ label, htmlFor, description, children }: { label: string; htmlFor?: string; description?: ReactNode; children: ReactNode }) {
  return <div className="@container/settings w-full min-w-0">
    <div className="flex flex-col gap-2.5 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-start @min-[36rem]/settings:justify-between @min-[36rem]/settings:gap-5">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block min-w-0 text-sm font-normal text-foreground">{label}</label>
        {description && <div className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">{description}</div>}
      </div>
      <div className="shrink-0 @min-[36rem]/settings:flex @min-[36rem]/settings:justify-end">{children}</div>
    </div>
  </div>;
}
const KEYS_URL = "https://console.typesafe.ai/keys";
/** One line about the saved key, and what Nudger is doing with it. */
function jevStatus(config: Configuration): { headline: string; problem: boolean; detail: ReactNode } {
  const keysLink = <a className="underline underline-offset-4 hover:text-foreground" href={KEYS_URL} target="_blank" rel="noreferrer">console.typesafe.ai</a>;
  if (config.key === "missing") return { headline: "No key yet", problem: false, detail: <>Paste your Jev API key above and Nudger turns on. Get one at {keysLink}.</> };
  if (config.key === "rejected") return { headline: "Key rejected", problem: true, detail: <>Jev didn't accept this key, so Nudger checks nothing. Paste a valid key from {keysLink}.</> };
  if (config.key === "unreachable") return { headline: "Couldn't check the key", problem: true, detail: `${config.keyDetail ?? "Jev didn't answer"}. Nudger turns on once Jev accepts the key.` };
  const headline = config.key === "connected" ? "Connected" : "Key saved";
  if (!config.active) return { headline, problem: false, detail: "Nudger is off: it checks nothing and sends nothing." };
  if (config.paused) return { headline, problem: false, detail: "Paused: no checks and no nudges until you resume." };
  return { headline, problem: false, detail: "Nudger is on. Jev reads the last reply of every thread that stops; unfinished work gets a nudge, everything else waits for you." };
}
function NudgerSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const connected = useRealtimeConnectionState() === "connected";
  const [config, setConfig] = useState<Configuration | null>(null);
  const [snapshot, setSnapshot] = useState<NudgerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef({ running: false, again: false, mounted: true });
  const refresh = useCallback(async () => {
    if (live.current.running) { live.current.again = true; return; }
    live.current.running = true;
    try {
      do {
        live.current.again = false;
        const [configuration, inventory] = await Promise.all([rpc.call("nudger_settings_v1", { version: 1 }), rpc.call("nudger_snapshot_v1", { version: 1 })]);
        if (!live.current.mounted) return;
        setConfig(configuration); setSnapshot(inventory); setError(null);
      } while (live.current.again);
    } catch (cause) { if (live.current.mounted) setError(cause instanceof Error ? cause.message : "Could not load Nudger. Try again."); }
    finally { live.current.running = false; }
  }, [rpc]);
  useEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false; }; }, []);
  useEffect(() => { void refresh(); }, [refresh, connected]);
  useRealtime("nudger-changed-v1", () => { void refresh(); });
  const act = async (operation: () => Promise<unknown>, failure: string) => {
    if (busy) return;
    setBusy(true);
    try { await operation(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : failure); }
    finally { setBusy(false); }
  };
  const status = config && jevStatus(config);
  return <section className="space-y-4 text-foreground" aria-busy={busy || !config}>
    {error && <div className="flex items-center gap-3" role="alert"><p className="min-w-0 flex-1 text-xs text-destructive">{error}</p><button type="button" className={BUTTON} onClick={() => { void refresh(); }}>Try again</button></div>}
    {!config && !error && <p className="text-xs text-muted-foreground" role="status">Loading Nudger…</p>}
    {config && status && <>
      <SettingRow label="Jev" description={<>
        <p role="status" className={`font-medium ${status.problem ? "text-destructive" : "text-foreground"}`}>{status.headline}</p>
        <p>{status.detail}</p>
      </>}>
        {config.key === "missing" || config.key === "rejected" ? <a className={BUTTON} href={KEYS_URL} target="_blank" rel="noreferrer">Get a key</a>
          : config.key === "unreachable" ? <button type="button" className={BUTTON} disabled={busy} onClick={() => { void act(() => rpc.call("nudger_settings_set_v1", { version: 1 }), "Could not check the key. Try again."); }}>Check again</button>
          : !config.active && <button type="button" className={BUTTON} disabled={busy} onClick={() => { void act(() => rpc.call("nudger_settings_set_v1", { version: 1, enabled: true, detector: "jev" }), "Could not turn Nudger on. Try again."); }}>Turn on</button>}
      </SettingRow>
      {config.active && <SettingRow label="Watching" description={<>
        <p role="status" className="tabular-nums">{snapshot ? `${snapshot.status.watchedCount} running ${snapshot.status.watchedCount === 1 ? "thread" : "threads"} · ${snapshot.status.threads.length} threads in view` : "Loading threads…"}</p>
        <p>Pause stops every check and cancels pending nudges until you resume.</p>
      </>}>
        <button type="button" className={BUTTON} disabled={busy} aria-pressed={config.paused} onClick={() => { void act(() => rpc.call("nudger_pause_v1", { version: 1, paused: !config.paused }), "Could not change the pause. Try again."); }}>{config.paused ? "Resume" : "Pause"}</button>
      </SettingRow>}
      {config.error && config.key !== "missing" && config.key !== "rejected" && <p className="text-xs text-destructive" role="status">{config.error}</p>}
    </>}
    {snapshot && snapshot.blockers.length > 0 && <div className="space-y-2 border-t border-border/60 pt-4">
      <h3 className="text-sm font-normal text-foreground">Needs your attention</h3>
      <ul className="divide-y divide-border/60">{snapshot.blockers.map(blocker => <li key={blocker.recordId} className="space-y-1 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <button type="button" className="min-w-0 cursor-pointer truncate text-left text-sm text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => navigate.toThread(blocker.threadId)}>{snapshot.status.threads.find(thread => thread.id === blocker.threadId)?.title ?? blocker.threadId}</button>
          <span className="shrink-0 text-xs capitalize text-muted-foreground">{blocker.kind}</span>
        </div>
        <p className="max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">{blocker.finalAssistantMessage}</p>
      </li>)}</ul>
    </div>}
  </section>;
}
export default definePluginApp(app => {
  app.slots.settingsSection({ id: "nudger-settings-v1", title: "Status", description: "What Nudger is doing right now. Stop in a thread holds its nudges until your next message; the eye in a thread's composer turns nudges off for that thread.", component: NudgerSettings });
  app.slots.navPanel({ id: "stats", title: "Nudger", icon: "nudger/hand", path: "stats", component: NudgerStatsPage });
  app.composer.customize({ id: "nudger-continuation-v1", scopes: ["thread"], banners: [{ id: "nudger-continuation-banner-v1", chrome: "bare", component: ContinuationBanner }] });
});
