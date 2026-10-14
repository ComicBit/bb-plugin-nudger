import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./rpc-contract.js";
import type { AttentionItem, NudgerStats, StatsRange } from "./stats.js";
import { BUTTON, FOCUS } from "./ui.js";

const RANGES: readonly StatsRange[] = ["day", "week", "month"];
const RANGE_KEY = "nudger:stats-range";
const rangeText: Record<StatsRange, { button: string; span: string; current: string; utc: string }> = {
  day: { button: "Day", span: "last 14 days", current: "today", utc: "UTC days" },
  week: { button: "Week", span: "last 12 weeks", current: "this week", utc: "ISO weeks starting Monday, UTC" },
  month: { button: "Month", span: "last 6 months", current: "this month", utc: "Calendar months, UTC" },
};
const kindText: Record<AttentionItem["kind"], string> = { blocker: "Blocked", permission: "Permission", uncertainty: "Decision needed" };
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthShort = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthYear = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const weekdayNarrow = new Intl.DateTimeFormat("en-US", { weekday: "narrow", timeZone: "UTC" });
const weekdayLong = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const count = new Intl.NumberFormat(undefined);
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
const usdSmall = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const usdLarge = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$0.00" for nothing, "< $0.0001" below display precision, four decimals under a dollar, cents above. */
function formatUsd(amount: number): string {
  if (amount <= 0) return "$0.00";
  if (amount < 0.0001) return "< $0.0001";
  return (amount < 1 ? usdSmall : usdLarge).format(amount);
}
function ago(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  if (Math.abs(minutes) < 60 * 36) return relative.format(Math.round(minutes / 60), "hour");
  return relative.format(Math.round(minutes / 1440), "day");
}
function periodTitle(start: string, range: StatsRange): string {
  if (range === "week") return `Week of ${monthDay.format(utc(start))}`;
  if (range === "month") return monthYear.format(utc(start));
  return weekdayLong.format(utc(start));
}
function axisLabel(start: string, range: StatsRange, fromEnd: number): string {
  if (range === "day") return weekdayNarrow.format(utc(start));
  if (range === "month") return monthShort.format(utc(start));
  // Twelve week dates crowd a column: every third week, ending on the current one.
  return fromEnd % 3 === 0 ? monthDay.format(utc(start)) : "";
}
/** "since Oct 2" when the source starts inside the range, so missing periods never read as zeros. */
function coverageSince(points: ReadonlyArray<{ start: string }>, coverageStart: string | null): string | null {
  return coverageStart !== null && coverageStart > points[0]!.start ? monthDay.format(utc(coverageStart)) : null;
}

/** Per device; Day until the operator picks another range. */
function useStoredRange(): [StatsRange, (range: StatsRange) => void] {
  const [range, setRange] = useState<StatsRange>(() => {
    try { return RANGES.find(value => value === localStorage.getItem(RANGE_KEY)) ?? "day"; } catch { return "day"; }
  });
  return [range, next => {
    setRange(next);
    try { localStorage.setItem(RANGE_KEY, next); } catch { /* The choice still applies for this view. */ }
  }];
}

interface ChartPoint { start: string; covered: boolean; value: number; detail: string }
/** Fixed slots for the whole range; periods before the source's coverage show "No data yet", never zero. */
function BarChart({ label, points, range }: { label: string; points: ChartPoint[]; range: StatsRange }) {
  const maximum = Math.max(0, ...points.filter(point => point.covered).map(point => point.value));
  return <div role="group" aria-label={label} className="grid h-32 gap-1" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
    {points.map((point, index) => {
      const fromEnd = points.length - 1 - index;
      const description = `${periodTitle(point.start, range)}: ${point.covered ? point.detail : "No data yet"}`;
      const height = point.covered && maximum > 0 ? Math.max(point.value / maximum * 100, point.value > 0 ? 3 : 0) : 0;
      return <div key={point.start} className="flex min-w-0 flex-col gap-1" role="img" aria-label={description} title={description}>
        <div className="flex min-h-0 flex-1 items-end border-b border-border/60">
          {point.covered
            ? <div className={`w-full rounded-t-sm ${fromEnd === 0 ? "bg-foreground/70" : "bg-foreground/30"}`} style={{ height: `${height}%` }} />
            : <div className="h-full w-full rounded-t-sm border border-dashed border-border/60" />}
        </div>
        <span className="h-3 truncate text-center text-[10px] leading-3 text-muted-foreground" aria-hidden="true">{axisLabel(point.start, range, fromEnd)}</span>
      </div>;
    })}
  </div>;
}

function Card({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return <section className="space-y-3 rounded-lg border border-border/60 bg-card p-4" aria-label={title}>
    <header className="flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {meta && <span className="truncate text-xs text-muted-foreground">{meta}</span>}
    </header>
    {children}
  </section>;
}

function NudgesCard({ nudges, range, open }: { nudges: NudgerStats["nudges"]; range: StatsRange; open(threadId: string): void }) {
  const points = nudges.series[range];
  const covered = points.filter(point => point.covered);
  const total = covered.reduce((sum, point) => sum + point.nudges, 0);
  const since = coverageSince(points, nudges.coverageStart);
  const current = points.at(-1)!;
  return <Card title="Nudges" meta={since ? `since ${since}` : rangeText[range].span}>
    <div className="flex items-baseline justify-between gap-3" title={rangeText[range].utc}>
      <p className="flex items-baseline gap-1.5"><strong className="text-2xl font-semibold tabular-nums text-foreground">{current.covered ? count.format(current.nudges) : "—"}</strong><span className="text-xs text-muted-foreground">{rangeText[range].current}</span></p>
      <span className="text-xs tabular-nums text-muted-foreground">{covered.length ? since ? `${count.format(total)} since ${since}` : `${count.format(total)} in the ${rangeText[range].span}` : "No counts yet"}</span>
    </div>
    <BarChart label={`Nudges, ${since ? `since ${since}` : rangeText[range].span}, counted in UTC`} range={range}
      points={points.map(point => ({ start: point.start, covered: point.covered, value: point.nudges, detail: `${count.format(point.nudges)} ${point.nudges === 1 ? "nudge" : "nudges"}` }))} />
    <p className="text-xs leading-snug text-muted-foreground">Recorded nudges only; not a reconstructed lifetime total. Distinct execution endings have no nudge ceiling.</p>
    {nudges.recent.length > 0 && <details className="group text-xs">
      <summary className={`cursor-pointer select-none rounded-sm text-muted-foreground hover:text-foreground ${FOCUS}`}>Latest {nudges.recent.length} {nudges.recent.length === 1 ? "nudge" : "nudges"}</summary>
      <ul className="mt-2 divide-y divide-border/60">{nudges.recent.map(nudge => <li key={nudge.recordId}>
        <button type="button" className={`flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-sm py-1.5 text-left hover:bg-state-hover ${FOCUS}`} title={nudge.reason} onClick={() => open(nudge.threadId)}>
          <span className="min-w-0 flex-1 truncate text-foreground">{nudge.title}</span>
          <span className="shrink-0 text-muted-foreground">please continue</span>
        </button>
      </li>)}</ul>
    </details>}
  </Card>;
}

function JevCard({ jev, range }: { jev: NudgerStats["jev"]; range: StatsRange }) {
  if (!jev) return <Card title="Jev costs"><p className="text-xs text-muted-foreground" role="status">The Jev usage ledger could not be read.</p></Card>;
  const points = jev.series[range];
  const covered = points.filter(point => point.covered);
  const sum = (pick: (point: typeof points[number]) => number) => covered.reduce((total, point) => total + pick(point), 0);
  const requests = sum(point => point.requests);
  const errors = sum(point => point.errors);
  const tokens = sum(point => point.inputTokens);
  const since = coverageSince(points, jev.coverageStart);
  // Six calendar months contain every shorter range.
  const checked = jev.series.month.some(point => point.requests > 0);
  return <Card title="Jev costs" meta={since ? `since ${since}` : rangeText[range].span}>
    {jev.outOfCredits && <div className="space-y-1.5 rounded-md border border-destructive/40 p-3" role="status">
      <p className="text-xs font-medium text-destructive">Out of TypeSafe credits</p>
      <p className="text-xs leading-snug text-muted-foreground">Replies aren't being checked, so no thread is nudged. Add credits at console.typesafe.ai.</p>
      <a className={BUTTON} href="https://console.typesafe.ai/settings/billing" target="_blank" rel="noreferrer">Add credits</a>
    </div>}
    {checked || jev.outOfCredits ? <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1" title={rangeText[range].utc}>
        <strong className="text-2xl font-semibold tabular-nums text-foreground">{formatUsd(sum(point => point.costUsd))}</strong>
        <span className="text-xs tabular-nums text-muted-foreground">{count.format(requests)} {requests === 1 ? "check" : "checks"} · {count.format(tokens)} input tokens{errors > 0 && ` · ${count.format(errors)} failed`}</span>
      </div>
      <BarChart label={`Jev costs, ${since ? `since ${since}` : rangeText[range].span}, counted in UTC`} range={range}
        points={points.map(point => ({ start: point.start, covered: point.covered, value: point.costUsd, detail: `${formatUsd(point.costUsd)} · ${count.format(point.requests)} ${point.requests === 1 ? "check" : "checks"}${point.errors ? ` · ${count.format(point.errors)} failed` : ""}` }))} />
    </> : <p className="text-xs text-muted-foreground" role="status">No Jev checks yet.</p>}
    <p className="text-xs leading-snug text-muted-foreground">Estimated from tokens at ${jev.usdPerMillionInputTokens} per million input tokens; output tokens are free. TypeSafe has no billing API.</p>
  </Card>;
}

function AttentionList({ items, now, open }: { items: AttentionItem[]; now: number; open(threadId: string): void }) {
  if (!items.length) return <p className="rounded-lg border border-dashed border-border/60 p-6 text-center text-xs leading-snug text-muted-foreground" role="status">Nothing needs your attention. Blockers, permission requests and open questions from watched threads appear here.</p>;
  return <ul className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card">{items.map(item => <li key={item.id}>
    <button type="button" className={`flex w-full min-w-0 cursor-pointer flex-col gap-1 px-4 py-3 text-left transition-colors duration-150 hover:bg-state-hover hover:duration-0 ${FOCUS}`} onClick={() => open(item.threadId)}>
      <span className="flex w-full min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{item.title}</span>
        <span className={`shrink-0 rounded-sm border px-1.5 text-[11px] leading-4 ${item.kind === "blocker" ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground"}`}>{kindText[item.kind]}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">{[item.project, ago(item.observedAt, now)].filter(Boolean).join(" · ")}</span>
      <span className="w-full truncate text-xs text-muted-foreground/90" title={item.summary}>{item.summary}</span>
    </button>
  </li>)}</ul>;
}

export function NudgerStatsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const connected = useRealtimeConnectionState() === "connected";
  const [stats, setStats] = useState<NudgerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [range, chooseRange] = useStoredRange();
  const live = useRef({ running: false, again: false, mounted: true });
  const refresh = useCallback(async () => {
    if (live.current.running) { live.current.again = true; return; }
    live.current.running = true;
    try {
      do {
        live.current.again = false;
        const next = await rpc.call("nudger_stats_v1", { version: 1 });
        if (!live.current.mounted) return;
        setStats(next); setNow(Date.now()); setError(null);
      } while (live.current.again);
    } catch (cause) { if (live.current.mounted) setError(cause instanceof Error ? cause.message : "Could not load Nudger stats. Try again."); }
    finally { live.current.running = false; }
  }, [rpc]);
  useEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false; }; }, []);
  useEffect(() => { void refresh(); }, [refresh, connected]);
  useRealtime("nudger-changed-v1", () => { void refresh(); });
  // Ages stay current between changes.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const open = (threadId: string) => navigate.toThread(threadId);

  return <div className="@container/stats h-full min-h-0 overflow-y-auto text-foreground">
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 @min-[40rem]/stats:p-6" aria-busy={!stats && !error}>
      {error && <div className="flex items-center gap-3" role="alert"><p className="min-w-0 flex-1 text-xs text-destructive">{error}</p><button type="button" className={BUTTON} onClick={() => { void refresh(); }}>Try again</button></div>}
      {!stats && !error && <p className="text-xs text-muted-foreground" role="status">Loading Nudger stats…</p>}
      {stats && <div className="grid grid-cols-1 gap-6 @min-[56rem]/stats:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-base font-medium">Statistics</h1>
            <div className="inline-flex rounded-md border border-input p-0.5" role="group" aria-label="Chart range">
              {RANGES.map(value => <button key={value} type="button" aria-pressed={range === value} onClick={() => chooseRange(value)}
                className={`h-6 cursor-pointer rounded-[5px] px-2.5 text-xs font-medium transition-colors duration-150 hover:duration-0 ${range === value ? "bg-state-hover text-foreground" : "text-muted-foreground hover:text-foreground"} ${FOCUS}`}>{rangeText[value].button}</button>)}
            </div>
          </div>
          <NudgesCard nudges={stats.nudges} range={range} open={open} />
          <JevCard jev={stats.jev} range={range} />
        </div>
        <div className="min-w-0 space-y-4">
          <div className="flex h-7 items-center justify-between gap-3">
            <h1 className="text-base font-medium">Needs attention</h1>
            {stats.attention.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{count.format(stats.attention.length)}</span>}
          </div>
          <AttentionList items={stats.attention} now={now} open={open} />
        </div>
      </div>}
    </div>
  </div>;
}
