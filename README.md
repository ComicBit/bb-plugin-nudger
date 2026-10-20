# Nudger

Nudger is a standalone BB plugin that watches native threads, shows why a thread needs attention, and can send guarded `please continue` messages when an assistant has stopped prematurely. It works without Headquarters, Hermes, or a machine connection. Fresh installs are **observe-only**: the detector defaults to **none**, with no model calls or automatic messages.

## Install

Requires BB >=0.46 and Plugin SDK >=0.6.39. To install from a standalone source checkout:

```sh
npm install --include=dev
npm run build
bb plugin install path:/absolute/path/to/bb-plugin-nudger --yes
```

The package is `bb-plugin-nudger`, the installed plugin ID is `nudger`, and its CLI command is `bb nudger`. All sources and dependencies belong to this package; no parent repository is required. Building and installing changes the selected BB installation, so use a separate development installation when testing.

## Set up Jev (optional, paid external service)

Leave **Detector → None — observe only** selected to use inventory, composer banners, and local statistics without external classification. Adding a key alone does not select a detector, and importing old Headquarters state never enables paid classification.

To enable Jev:

1. Create or sign in to **your own TypeSafe account** at [console.typesafe.ai](https://console.typesafe.ai), obtain your own API key, and arrange any required credits/billing there. Nudger does not include a shared account, API key, or TypeSafe credits.
2. In BB, open **Settings → Installed plugins → Nudger**.
3. Enter the key in **TypeSafe API key**, the secret setting. Do not paste it into a thread, source file, issue, or decision-log export.
4. Explicitly select **Detector → Jev — TypeSafe API**. Keep **Enable automatic continuation** on only if you want classification and guarded automatic messages.
5. Check Nudger's status/settings for configuration errors. Use **Pause classification** to suspend checks and cancel pending nudges; the composer eye controls one thread, and countdown **Cancel** cancels one decision.

**Fail-safe behavior:** no detector means no model calls or nudges. With Jev selected, a missing/invalid key, exhausted credits, service failure, or malformed classification cannot turn into a blind send: the affected ending is gated or recorded as an error, not automatically continued. Restore configuration deliberately; startup and resume do not replay historical endings.

Jev calls TypeSafe directly and requires no host, Hermes, or Headquarters. It classifies only newly observed eligible live root endings, not a startup backlog.

## How guarded continuation works

- **Jev classification:**
  Jev reads only the final message. An ending that reports a state the operator chose (paused, frozen, declined, stopped as instructed, waiting on a named person) classifies as finished: neither reported nor nudged. An ending that asks the operator for anything (Jev's `ending` is `request`, or `waits_on` is `operator`) is never continued. Otherwise Jev's `waits_on` decides what kind of continuation is due:
  - **Nudge now** (`waits_on: assistant`, at least 0.6): the assistant itself must take the next step and obstacle `none` and boundary `continue` both hold at 0.9 or more. `please continue` goes out after 20 seconds.
  - **Check-in** (`waits_on: running`, at least 0.6, obstacle `none`): the remaining work runs in something the assistant started (another thread or agent, a shell task, a build, deploy, CI job or watcher). That work may wake the thread when it ends, so `please continue` is scheduled 30 minutes out, doubling with each unanswered nudge. Anything reaching the thread first (the operator, another thread, a finished child or task) cancels it.
  - After 3 nudges in a row with nothing else reaching the thread, its next continuation is suppressed (gate `nudge-streak`) until something else arrives. The streak lives in memory and resets on restart.

  Each reported obstacle also carries Jev's `consequence` (money, data, production, priority-product, irreversible, none) and whether the ending asks the operator for something (`operatorRequest`), additive optional v1 blocker fields. After a reload, retained obstacles judged before these questions existed are re-judged once from their recorded final message (at most 5 per read and 25 per process, only while Jev is selected and unpaused).
- **Luna was removed.** A stored Luna choice reads as none: Nudger only observes and shows the gate "Luna was removed; select Jev" until you select Jev or None. Retained endings classified by Luna stay readable in history.
- **Enable automatic continuation:** off leaves observation running but disables classification and dispatch.
- **Pause classification:** persisted across reloads; pauses classification and cancels pending nudges. Resume does not replay missed endings.

A detector sees only the final assistant message, treated as untrusted data. A continuation judgment schedules `please continue` after 20 seconds, or 30 minutes for a check-in (above). The composer eye turns automatic continuation off/on for one thread; the countdown Cancel cancels that decision. Counts survive reload and the diagnostic log limit. Hidden/child/control conversations are excluded. Stop remains suppressive until admitted human work re-arms the thread; workflows and compaction hold the original ending and re-check it only after settlement. Successful held judgments are reused only within the same runtime and detector instance. Queued continuation rows are withheld/deleted rather than dispatched unchecked.

A thread whose subthread is still running has not stopped: the subthread reports its final response back when it finishes, which wakes the parent. So while any subthread under a thread runs (nested ones included; a subthread's own workflow too), the parent's ending is neither sent to Jev nor nudged, and a pending nudge is withheld at send time (gate `subthread-hold`), exactly like a running workflow (`workflow-hold`). The composer banner reads "Waiting for its subthreads". When the last one ends, Nudger waits up to 2 minutes for the report; the run the report starts supersedes the held ending and ends the wait. If no report arrives (parent notifications off, say), the unchanged ending is judged once the 2 minutes pass.

**Safety boundary:** stock BB's dispatch hook is not an atomic core commit fence for Stop/queue races. Nudger preserves the existing conservative plugin-owned admission checks; it does not claim to solve that upstream limitation or authorize a new assignment, permission, spend, or publication.

## Privacy and external processing

Selecting Jev sends each eligible **final assistant message**, plus the classification questions/model identifier, over HTTPS to TypeSafe's API (`api.typesafe.ai`). Nudger does not send the full thread history as the classifier input, but a final message can itself contain quoted conversation, source code, credentials, or other sensitive information. Only enable Jev for data you are allowed to share with that third-party service. TypeSafe is external and may charge for calls; its own privacy, retention, and billing terms apply. Review them in your account before enabling it. The Stats page's cost estimate is not a TypeSafe bill or live credit balance.

Even in observe-only mode, Nudger retains local thread inventory and decision data in BB plugin storage. Decision logs can include final-message text, thread/project identifiers, Jev answers, labels, and nudge outcomes. Detailed decisions/text are retained for up to 30 days subject to storage caps; selected history and usage/count data are retained longer as described below. The Stats page caches displayed titles and obstacle summaries on this device for up to 7 days. Decision exports are local JSONL files and may contain sensitive data: review and redact them before sharing. Optional Headquarters integration exposes the documented snapshots/history to that plugin; settings and API keys are not included in snapshots.

## Stats page

The **Nudger** destination in BB's navigation rail (`/plugins/nudger/stats`) shows, side by side on wide panes and stacked on narrow ones:

- **Statistics:** recorded nudges and Jev costs per Day (last 14 UTC days), Week (last 12 ISO weeks) or Month (last 6 calendar months); the range choice is remembered on this device. Periods before the first retained record (or the Jev ledger's first day) read as "no data yet", not zero. Jev shows checks, failed checks and input tokens, priced at $0.042 per million input tokens (output tokens are free; TypeSafe has no billing API), plus an out-of-credits warning when the newest Jev ending failed for billing.
- **Needs attention:** every current obstacle Nudger knows of, newest first: live blockers revalidated against current thread state, plus retained blocker/permission/question reports that no later ending on the same listed thread has superseded. Selecting one opens the thread.

The page reads `nudger_stats_v1` and refreshes on Nudger's realtime change notifications. It opens on the last stats it showed (kept in memory while BB runs and in this device's local storage for up to 7 days, written at most once per 2-second burst) and replaces them when the read lands: "Updating…" marks cached stats until then, and a failed read keeps them on screen as "Couldn’t refresh · updated …" with Try again. Stored stats from another Nudger version are discarded, not shown. The cache holds what the page shows: thread titles and one-sentence obstacle summaries.

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
- **Published history.** `nudger_snapshot_v1`/`nudger_history_v1` expose the last week, 183 days of nudges, and each thread's latest record. Decision outcomes and labels do not change their history digest.
- **Export.** `nudger_decisions_v1({version:1,cursor:null|string,since?:epochMs})` → `{version:1,decisions,nextCursor}`, oldest first, at most 200 rows/256 KiB per page; the cursor is the last row's `observedAt:id` and stays valid while older rows are pruned. `bb nudger decisions` writes every page as JSON Lines (one decision per line) to `--out` (relative to your working directory) or `<BB data dir>/plugins/nudger/exports/decisions-<time>.jsonl`, and prints the path and counts. Native clients and Headquarters may read it; other plugins may not.
- **Labels.** `nudger_label_v1({version:1,recordId,label:"wrong"|null,note?,by})` (or `bb nudger label`) marks a decision wrong, or clears it. The label lives on the record, survives restarts and pruning until the record ages out, and is exported, so labelled decisions form a test set. Native clients and Headquarters only.

Each exported decision is a v1 record (`id`, `threadId`, `projectId`, `runId`, `messageId`, `messageRevision`, `observedAt`, `classification`, `action`, `reason`, `detector`, `judgment` with every Jev question's `choice`, `confidence` and `probabilities`) plus:

- `gate`: stable id of what decided `action`, `reason` being its wording. Admission: `pending`, `no-detector`, `paused`, `identities-unavailable`, `policy-changed`, `cancelled-before-classification`, `workflow-hold`, `subthread-hold`, `maintenance`, `restart`. Lifecycle: `superseded`, `operator-stop`, `history-reset`, `thread-archived`, `ineligible`, `not-followable`, `observation-failed`, `detector-changed`, `disposed`, `control-thread`, `stale-ending`. Verdict: `nudge-scheduled`, `check-in-scheduled`, `nudge-streak`, `auto-continue-off`, `finished`, `obstacle`, `obstacle-reported`, `detector-error`, `no-credits`, `rejudged`. Null on records from before the log existed.
- `text`, `textTruncated`: the judged final message.
- `nudge`: `{nudgeId, text, scheduledAt, sendAt, state, gate, reason}` for a scheduled nudge: the exact text sent and its fate. Its send-time `gate` is `operator-cancel`, `operator-replied`, `auto-continue-off`, `paused`, `operator-stop`, `superseded`, `fresh-activity`, `active-execution`, `message-changed`, `workflow-hold`, `subthread-hold`, `queued`, `maintenance`, `restart`, `send-failed`, `nudge-cancelled` or `nudge-withheld`; null while pending or once sent.
- `outcome`: what the thread did next within 24 hours, settled once: `next-ending` (`nextRecordId` plus that ending's `classification`/`action` as they settle), `stopped` (a manual Stop), `cancelled` (you cancelled the countdown, turned the thread off, paused, or replied first), or `none` (nothing within 24 hours; filled lazily). Null while the window is open, and on records from before the log existed.
- `label`: `{label:"wrong", note, by, at}` or null.

## Optional Headquarters integration and migration

Headquarters is **not required**. Without it, inventory, Jev, per-thread controls, local history, attention items, and Stats work independently.

When installed, Headquarters uses the stable plugin ID `orchestrator`. Nudger discovers it with public `sdk.plugins.list`/`callRpc` and reads `headquarters_controls_v1` so current Headquarters control conversations are excluded from classification and continuation. Absence, disablement, or incompatibility does not gate unrelated watching; transient RPC failures retain the last known exclusions. Current controls are checked again before paid classification and owned message dispatch.

Headquarters can consume the versioned `nudger_snapshot_v1`, `nudger_history_v1`, `nudger_pause_v1`, `nudger_stats_v1`, `nudger_decisions_v1`, and `nudger_label_v1` interfaces. Read-only discovery/settings/status/history/stats remain available to plugin callers. Only native operator clients may change settings, secrets, per-thread toggles or countdown cancellation; authenticated Headquarters can also forward global pause/resume. Decision exports and labels are limited to native clients and authenticated Headquarters.

The public schema/type source is **this package's `nudger-contract.ts`**, exported as `bb-plugin-nudger/contract`. TypeScript consumers using `tsx` or BB's bundler can import it directly:

```ts
import { snapshotSchema, type NudgerSnapshot } from "bb-plugin-nudger/contract";
```

The export is TypeScript source, not a standalone plain-Node JavaScript entry point. Integration consumers should depend on the package rather than maintain a second compatibility copy.

When authenticated legacy `nudger_export_v1` is available, Nudger copies recovery, continuation and usage history through that public API, never through private database access. Imported rows form immutable baselines; explicit Nudger values win and counters combine with new deltas without double-counting. Durable checkpoints allow migration to resume after interruption. Old pending nudges become cancelled diagnostic records, **never active timers**. Migration is non-destructive and does not write standard BB settings, select a paid detector, copy a credential, or change the source encrypted key. Enter your own TypeSafe key in Nudger's secret setting and explicitly select Jev to enable it. A legacy Luna choice remains observe-only with a removed-detector notice.

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

