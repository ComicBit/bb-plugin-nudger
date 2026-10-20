# Nudger

Independent native thread watching and guarded continuation. ID: `nudger`; command: `bb nudger`. Headquarters, Hermes, and a machine are unnecessary for passive inventory or Jev.

## Default and controls

The effective detector defaults to **none**: inventory and composer banners work without setup, model calls, or outgoing messages. Jev, the only detector, requires the TypeSafe secret setting; a missing key keeps classification gated. Luna was removed: a stored or imported Luna choice reads as none behind the gate "Luna was removed; select Jev", and Luna-era records stay readable.

Disable keeps passive observation running without classification/dispatch. Pause is persisted and cancels pending nudges. The composer eye toggles one thread; countdown Cancel cancels that decision. Stop suppresses future endings until admitted human work. Running subthreads (nested ones included), workflows and compaction hold the original ending and repeat current-state checks after settlement: a running subthread reports back and wakes its parent, so the parent has not stopped and is neither classified nor nudged (gate `subthread-hold`). The settle after the last one ends lasts up to 2 minutes and ends early when the report starts a new root run. Counts, history, pause and toggles survive reload.

Only newly observed live root endings are classified, using only the final assistant message as untrusted data. Startup never catches up on old endings. An ending that asks the operator for anything is never continued. When Jev names the assistant itself as next (`waits_on: assistant`), a nudge waits 20 seconds; when the remaining work runs in something the assistant started (`waits_on: running`), a check-in waits 30 minutes (doubling per unanswered nudge) and anything reaching the thread first cancels it. Three unanswered nudges in a row stop further ones until something else arrives. Every continuation is rechecked at dispatch; queued rows are withheld/deleted. No model verdict authorizes new work, permission, spend, or publication. Stock BB's hook is not an atomic core Stop/queue commit fence; the existing conservative guards do not claim to fix that upstream limit.

## Stats page

The `stats` navigation panel (`/plugins/nudger/stats`, hand glyph `nudger/hand`) reads `nudger_stats_v1` and refreshes on `nudger-changed-v1`. It opens on its last stats (memory, plus device local storage up to 7 days, schema-checked on load) and revalidates: "Updating…" until the read lands, "Couldn’t refresh · updated …" when it fails. Left: recorded nudges and Jev costs (requests, failures, input tokens, $0.042 per million input tokens, output free) per 14 UTC days / 12 ISO weeks / 6 months, with uncovered periods shown as no data; the range is kept in localStorage. Right: every current obstacle, newest first (live revalidated blockers plus unsuperseded reported records on listed threads); selecting one opens its thread. Columns stack on narrow panes.

## Optional public integration

Discovery uses `sdk.plugins.list/callRpc`, with no dependency declaration or private DB access. Stable Headquarters ID `orchestrator` supplies `headquarters_controls_v1` (`{version:1,threadIds}`). Current controls are checked before classification/routing and owned dispatch. Absence/disablement/incompatibility does not gate unrelated watching; transient RPC failure retains known exclusions.

- `nudger_snapshot_v1({version:1})` → version, historyVersion, status, newest records, Jev usage, live blockers.
- `nudger_history_v1({version:1,cursor:null|recordId})` → records, nextCursor. Full retained history is paginated in stable ID order; pages cap at 200 rows/256 KiB.
- `nudger_pause_v1({version:1,paused})` → versioned paused state; native clients and authenticated Headquarters may invoke it.
- `nudger_stats_v1({version:1})` → nudge and Jev usage series per range, coverage starts, out-of-credits flag and current attention items; read-only for any caller. Records keep their producing detector id, so Luna-era history stays valid.
- `nudger_decisions_v1({version:1,cursor:null|string,since?})` → decisions, nextCursor. The 30-day decision log, oldest first, 200 rows/256 KiB pages; native clients and Headquarters only.
- `nudger_label_v1({version:1,recordId,label:"wrong"|null,note?,by})` → the labelled decision; native clients and Headquarters only.

The history digest includes same-ID action/judgment changes. Consumers reuse history while it stays unchanged. Outgoing blocker text caps at 24,576 characters/item and 256 KiB together; classifier input is unchanged. Snapshot inventory has separate byte limits with explicit omitted-inventory gates; native observation still scans every page. Live obstacles are revalidated against current public thread/history state, never replayed from historical reports. Without Headquarters they appear in Nudger settings.

Decision log: every ending's decision (all seven actions) is kept 30 days with its judged text (compressed, 24,576-character cap), Jev's answers, a stable deciding `gate`, the nudge sent and its fate, the outcome (next ending, Stop, operator cancel, or none within 24 h) and an optional `wrong` label. Hard caps of 10,000 decisions / 24 MiB prune oldest first. `bb nudger decisions` exports it as JSONL; `bb nudger label` sets labels. v1 snapshot/history publish exactly the previous record set and fields. Format and gate ids: README "Decision log".

Authenticated `nudger_export_v1` supports copy-only legacy migration, bounded pages and durable checkpoints after all entries land. Every imported KV row is an immutable baseline; explicit Nudger values shadow it and counters combine with own deltas without double-counting. Old pending nudges become cancelled diagnostic decisions, never timers. Migration never writes standard BB settings or activates an imported paid engine: the imported detector choice is nonsecret setup information only. Enter your TypeSafe key in Nudger's secret field and explicitly select Jev. The encrypted Headquarters credential stays untouched; no raw key is copied into KV, logs or snapshots. Settings, toggles and countdown cancellation are operator-only; authenticated Headquarters has only the pause bridge. Detailed migration/privacy boundaries are in README.

## Package and release

All sources are local; composer/event/CSS IDs are Nudger-specific. The self-contained public protocol is copied into Headquarters. Lucide attribution ships in `lucide-LICENSE.txt`.

The package ships source and metadata-stamped `dist`; `prepack` builds server/app artifacts. Offline checks: typecheck, Node tests, build, package dry-run. Tests use fake hosts and synthetic HTTP responses. `status`, continuation reads and `verify` are read-only. Only explicit `shadow --confirm-paid-synthetic` makes paid calls (Jev against the synthetic corpus); it never dispatches project work. See README for release and safety details.
