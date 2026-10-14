# Nudger

An independently installable BB plugin for passive native thread watching and guarded automatic continuation. Headquarters is optional. Neither Hermes nor a machine is needed for passive watching or Jev, the only detector.

## Install

Requires BB >=0.46 and Plugin SDK >=0.6.39. From this directory:

```sh
npm install --include=dev
npm run build
bb plugin install path:/absolute/path/to/nudger --yes
```

From this repository, install only this package with `bb plugin install path:/absolute/path/to/bb-plugin-orchestrator --subdirectory nudger --yes`. The plugin ID is `nudger`; the command is `bb nudger`. Copying this directory elsewhere does not require its parent repository.

Open Settings → Installed plugins → Nudger. The detector defaults to **none**: inventory and composer banners work without setup, model calls, or outgoing messages. A selected detector can classify only newly observed live root endings; startup never catches up on historical endings.

- **Jev:** enter a TypeSafe key in the secret setting and select Jev. It calls TypeSafe directly and needs no host, Hermes, or Headquarters.
  Jev reads only the final message. An ending that reports a state the operator chose (paused, frozen, declined, stopped as instructed, waiting on a named person) classifies as finished: neither reported nor nudged. Each reported obstacle also carries Jev's `consequence` (money, data, production, priority-product, irreversible, none) and whether the ending asks the operator for something (`operatorRequest`), additive optional v1 blocker fields. After a reload, retained obstacles judged before these questions existed are re-judged once from their recorded final message (at most 5 per read and 25 per process, only while Jev is selected and unpaused).
- **Luna was removed.** A stored Luna choice reads as none: Nudger only observes and shows the gate "Luna was removed; select Jev" until you select Jev or None. Retained endings classified by Luna stay readable in history.
- **Enable automatic continuation:** off leaves observation running but disables classification and dispatch.
- **Pause classification:** persisted across reloads; pauses classification and cancels pending nudges. Resume does not replay missed endings.

A detector sees only the final assistant message, treated as untrusted data. A continuation judgment schedules `please continue` after 20 seconds. The composer eye turns automatic continuation off/on for one thread; the countdown Cancel cancels that decision. Counts survive reload and the diagnostic log limit. Hidden/child/control conversations are excluded. Stop remains suppressive until admitted human work re-arms the thread; workflows and compaction hold the original ending and re-check it only after settlement. Successful held judgments are reused only within the same runtime and detector instance. Queued continuation rows are withheld/deleted rather than dispatched unchecked.

**Safety boundary:** stock BB's dispatch hook is not an atomic core commit fence for Stop/queue races. Nudger preserves the existing conservative plugin-owned admission checks; it does not claim to solve that upstream limitation or authorize a new assignment, permission, spend, or publication.

## Stats page

The **Nudger** destination in BB's navigation rail (`/plugins/nudger/stats`) shows, side by side on wide panes and stacked on narrow ones:

- **Statistics:** recorded nudges and Jev costs per Day (last 14 UTC days), Week (last 12 ISO weeks) or Month (last 6 calendar months); the range choice is remembered on this device. Periods before the first retained record (or the Jev ledger's first day) read as "no data yet", not zero. Jev shows checks, failed checks and input tokens, priced at $0.042 per million input tokens (output tokens are free; TypeSafe has no billing API), plus an out-of-credits warning when the newest Jev ending failed for billing.
- **Needs attention:** every current obstacle Nudger knows of, newest first: live blockers revalidated against current thread state, plus retained blocker/permission/question reports that no later ending on the same listed thread has superseded. Selecting one opens the thread.

The page reads `nudger_stats_v1` and refreshes on Nudger's realtime change notifications.

## CLI

```sh
bb nudger status
bb nudger continuation
bb nudger continuation <threadId>
bb nudger continuation <threadId> off
bb nudger continuation <threadId> on
bb nudger verify
bb nudger decisions [--since <ISO date|epoch ms>] [--out <path>]
bb nudger label '<recordId>' wrong [--by <name>] [--note <text>]
bb nudger label '<recordId>' clear
```

`status`, continuation reads, `decisions` and `verify` do not request a model. `verify` validates a stored complete synthetic validation for the exact currently selected detector; it is not a safety certification.

Only an explicit `bb nudger shadow --confirm-paid-synthetic` runs Jev against the bundled synthetic corpus, requires the TypeSafe key, and incurs detector calls. It never dispatches project messages. Do not run it for a release smoke that prohibits paid calls. All detector calls, including errors and synthetic validation calls, go through the persisted per-day ledger.

## Decision log

Nudger keeps why it decided what it did with every observed ending, whatever the action (observed, finished, reported, suppressed, nudged, discarded, error), for **30 days**, so its quality can be studied and improved later.

- **Storage.** Each decision is one KV row `recovery.records.<recordId>`; the judged final message (capped at 24,576 characters, like a published obstacle) is written once beside it at `recovery.text.<recordId>` as Brotli-compressed base64 (`{"br":"…"}`, about half the size of the raw text). Rewrites of an unchanged record are skipped.
- **Budget.** Hard caps of 10,000 decisions and 24 MiB (record JSON plus stored text); over either, the oldest decisions are pruned first, and the ones the v1 history view still publishes (each thread's latest, nudges inside the 183-day daily history, the detector's newest outcome, the coverage anchor) go last. Past 30 days only those history-view records remain, without text.
- **v1 unchanged.** `nudger_snapshot_v1`/`nudger_history_v1` publish the same records and fields as before (the last week, 183 days of nudges, each thread's latest), so Headquarters reads no more and outcomes or labels never change its history digest.
- **Export.** `nudger_decisions_v1({version:1,cursor:null|string,since?:epochMs})` → `{version:1,decisions,nextCursor}`, oldest first, at most 200 rows/256 KiB per page; the cursor is the last row's `observedAt:id` and stays valid while older rows are pruned. `bb nudger decisions` writes every page as JSON Lines (one decision per line) to `--out` (relative to your working directory) or `<BB data dir>/plugins/nudger/exports/decisions-<time>.jsonl`, and prints the path and counts. Native clients and Headquarters may read it; other plugins may not.
- **Labels.** `nudger_label_v1({version:1,recordId,label:"wrong"|null,note?,by})` (or `bb nudger label`) marks a decision wrong, or clears it. The label lives on the record, survives restarts and pruning until the record ages out, and is exported, so labelled decisions form a test set. Native clients and Headquarters only.

Each exported decision is a v1 record (`id`, `threadId`, `projectId`, `runId`, `messageId`, `messageRevision`, `observedAt`, `classification`, `action`, `reason`, `detector`, `judgment` with every Jev question's `choice`, `confidence` and `probabilities`) plus:

- `gate`: stable id of what decided `action`, `reason` being its wording. Admission: `pending`, `no-detector`, `paused`, `identities-unavailable`, `policy-changed`, `cancelled-before-classification`, `workflow-hold`, `maintenance`, `restart`. Lifecycle: `superseded`, `operator-stop`, `history-reset`, `thread-archived`, `ineligible`, `not-followable`, `observation-failed`, `detector-changed`, `disposed`, `control-thread`, `stale-ending`. Verdict: `nudge-scheduled`, `auto-continue-off`, `finished`, `obstacle`, `obstacle-reported`, `detector-error`, `no-credits`, `rejudged`. Null on records from before the log existed.
- `text`, `textTruncated`: the judged final message.
- `nudge`: `{nudgeId, text, scheduledAt, sendAt, state, gate, reason}` for a scheduled nudge: the exact text sent and its fate. Its send-time `gate` is `operator-cancel`, `operator-replied`, `auto-continue-off`, `paused`, `operator-stop`, `superseded`, `fresh-activity`, `active-execution`, `message-changed`, `workflow-hold`, `queued`, `maintenance`, `restart`, `send-failed`, `nudge-cancelled` or `nudge-withheld`; null while pending or once sent.
- `outcome`: what the thread did next within 24 hours, settled once: `next-ending` (`nextRecordId` plus that ending's `classification`/`action` as they settle), `stopped` (a manual Stop), `cancelled` (you cancelled the countdown, turned the thread off, paused, or replied first), or `none` (nothing within 24 hours; filled lazily). Null while the window is open, and on records from before the log existed.
- `label`: `{label:"wrong", note, by, at}` or null.

## Optional Headquarters integration and migration

Nudger discovers `orchestrator` (the stable installed ID of Headquarters) with public `sdk.plugins.list` and reads versioned `headquarters_controls_v1`. Headquarters absence, disablement, incompatibility, or incomplete configuration does not gate unrelated watching. Controls are re-read before paid classification/routing and owned continuation dispatch so its current selected/control conversations cannot be nudged. These safety reads wait out older in-flight discovery and start a new read; they never reuse a selection lookup started before the safety decision. The composer banner and live obstacle publication also check current controls. Transient peer RPC failure retains the last known control exclusions without blocking unrelated threads.

Headquarters can consume `nudger_snapshot_v1`, `nudger_history_v1`, and `nudger_pause_v1`. Read-only discovery, settings/status, history and `nudger_stats_v1` endpoints remain usable by plugins. Only native operator clients may mutate settings, secrets, per-thread toggles or countdown cancellation; authenticated Headquarters may additionally forward global pause/resume requests. Snapshots contain no settings or secrets. Live obstacles are revalidated against current public thread/history state before publication; persisted historical obstacles are not replayed as live attention items after startup. Without Headquarters, live obstacles remain visible in Nudger settings and on the Stats page. Records keep the detector id that produced them, so history from the removed Luna detector stays valid in the public v1 protocol.

When authenticated `nudger_export_v1` is available, Nudger copies legacy recovery/continuation/usage state through that public API before starting observation. Copy is non-destructive. Durable page checkpoints advance only after every entry is written, and retry skips already copied keys. All imported rows are immutable in a separate migration namespace; readers prefer explicit Nudger pause, per-thread and record values. Imported lifetime-send counts and daily usage buckets combine with Nudger's own counters, while new sends/calls persist only their own deltas. This preserves both histories if Headquarters becomes available after standalone initialization, without double-counting after a crash or reload. Pending old nudges become cancelled diagnostic decisions, never live timers. Incomplete policy restoration leaves observation running but classification gated. Maintenance retries the copy and reloads passive baselines when it completes.

Migration never writes Nudger's standard BB settings: SDK settings have no conditional setter, and native BB writes run outside the plugin mutation queue. An imported detector choice is retained only as nonsecret setup information; an imported Luna choice (and its machine) only produces the removed-detector notice. Migration does not enable a paid detector or copy any credential, even when the public export can read the old key. The source encrypted credential remains untouched. To use Jev, enter your TypeSafe key in Nudger's public secret field and explicitly select Jev. Existing explicit none/disable settings and operator secrets always remain authoritative. Plugin-owned settings/pause/toggle/cancel and CLI mutations share the migration queue; native settings changes immediately revoke stale configuration and fence pending configuration awaits. No private DB or secret-file access is used.

## Release preparation

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run --ignore-scripts
```

Run these in an isolated checkout without live messages/models. Node tests use the SDK fake host and synthetic detector HTTP responses; they do not hit paid APIs. Tests cover migration crash/retry/reload, immutable imported preferences with concurrent operator and direct BB settings writes, foreign-plugin mutation rejection, default passive factory startup/shutdown, the removed-Luna gate, public history pagination/digests, current control exclusions, native Stop, queued-row ownership, user-dispatch cancellation, live blocker revalidation, stats aggregation, and the transplanted workflow/compaction/detector/ledger suite.

The npm package includes its own sources, styles, SDK-pinned development metadata and built `dist` artifacts. `prepack` builds the package so a published npm archive includes BB's metadata-stamped server/app bundles. Source tests and unrelated Headquarters code are excluded from distribution. This repository change prepares the package; it does not publish a release or run a paid comparison.

No project license is declared yet. Choose licensing before public distribution; the included Lucide notice covers that artwork, not permission to redistribute the entire plugin.

