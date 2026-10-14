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
  const pause = async () => {
    if (!config || busy) return;
    setBusy(true);
    try { await rpc.call("nudger_pause_v1", { version: 1, paused: !config.paused }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change the pause. Try again."); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4 text-foreground" aria-busy={busy || !config}>
    {error && <div className="flex items-center gap-3" role="alert"><p className="min-w-0 flex-1 text-xs text-destructive">{error}</p><button type="button" className={BUTTON} onClick={() => { void refresh(); }}>Try again</button></div>}
    {!config && !error && <p className="text-xs text-muted-foreground" role="status">Loading Nudger…</p>}
    {config && <>
      <SettingRow label="Classification" description={<>
        <p role="status" className="tabular-nums">{snapshot ? `${snapshot.status.watchedCount} active executions watched · ${snapshot.status.threads.length} threads visible to the watcher` : "Loading native inventory…"}</p>
        <p>Pause prevents classification and cancels pending nudges.</p>
      </>}>
        <button type="button" className={BUTTON} disabled={busy} aria-pressed={config.paused} onClick={() => { void pause(); }}>{config.paused ? "Resume classification" : "Pause classification"}</button>
      </SettingRow>
      {config.error && <p className="text-xs text-destructive" role="status">{config.error}</p>}
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
  app.slots.settingsSection({ id: "nudger-settings-v1", title: "Watcher and automatic continuation", description: "Live watcher status and the global pause. Stop in a thread suppresses its future endings until your next message; the eye in a thread's composer turns auto-continue off for that thread.", component: NudgerSettings });
  app.slots.navPanel({ id: "stats", title: "Nudger", icon: "nudger/hand", path: "stats", component: NudgerStatsPage });
  app.composer.customize({ id: "nudger-continuation-v1", scopes: ["thread"], banners: [{ id: "nudger-continuation-banner-v1", chrome: "bare", component: ContinuationBanner }] });
});
