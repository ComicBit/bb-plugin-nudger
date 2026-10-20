# Nudger

Your agents stop halfway. “Want me to continue?” “Next I'll wire up the tests.” Then the thread sits idle until you come back and type “go on”. Nudger types it for you, but only when the work is really unfinished.

Nudger is a BB plugin. It watches every thread, and when an agent stops, [Jev](https://typesafe.ai) (TypeSafe's System One model) reads the last reply and judges what kind of stop it is:

- **Unfinished work** the agent can do itself: Nudger sends `please continue` after a 20-second countdown you can cancel.
- **A real blocker**, like a missing credential or a broken service: no nudge; it goes on your list.
- **A request for you**: permission, a decision, a review. Never continued, always shown to you.
- **Done**: left alone.

Only the first gets a nudge. Each thread's composer banner shows what Nudger decided, and the **Nudger** page lists every thread that needs you.

## Set up

1. Get an API key at [console.typesafe.ai](https://console.typesafe.ai/keys). TypeSafe bills Jev per input token; you bring your own account and credits.
2. In BB, open **Settings → Installed plugins → Nudger** and paste it in **Jev API key**.
3. Done. Nudger checks the key with Jev (one free `GET /v1/models` call) and turns itself on: **Judge** becomes Jev and **Automatic continuation** turns on.

The settings page shows the result: **Connected**, **Key rejected** (paste a valid key), or **Couldn't check the key** with a **Check again** button. Without a key Nudger judges nothing and sends nothing.

To install from a source checkout instead of the marketplace (BB >=0.46, Plugin SDK >=0.6.39):

```sh
npm install --include=dev
npm run build
bb plugin install path:/absolute/path/to/bb-plugin-nudger --yes
```

The package is `bb-plugin-nudger`, the installed plugin ID is `nudger`, and its CLI command is `bb nudger`.

## How it uses Jev

Jev writes no text. It answers typed questions about a piece of state with a probability for every option and a confidence score ([how Jev works](https://docs.typesafe.ai/introduction)). Nudger sends one request per stopped thread: the last assistant reply as `final_assistant_message`, and five Choice questions, pinned to `jev-1.13.0`:

| Question | Options |
| - | - |
| `obstacle`: what prevents progress | none, blocker, permission, uncertainty |
| `boundary`: is current work unfinished | continue, finished, uncertainty |
| `ending`: what the reply leaves for you | request, operator_chosen, report |
| `waits_on`: who must act next | assistant, running, operator, nothing |
| `consequence`: what is at stake | money, data, production, priority-product, irreversible, none |

Code, not Jev, decides what happens (`routeJevAnswers` in `detectors.ts`):

- A reply that reports a state you chose (paused, frozen, declined, stopped as instructed, waiting on a named person) counts as finished.
- A reply that asks you for anything (`ending: request` or `waits_on: operator`) is never continued.
- **Nudge now:** obstacle `none` and boundary `continue` both at 0.9 confidence or more, and `waits_on: assistant` at 0.6 or more. `please continue` goes out after 20 seconds.
- **Check-in:** obstacle `none` and `waits_on: running` (another thread or agent, a shell task, a build, deploy, CI job or watcher), both at 0.6 or more. That work may wake the thread itself, so `please continue` is scheduled 30 minutes out, doubling with each unanswered nudge. Anything reaching the thread first cancels it.
- Unfinished work below the nudge bar, or any verdict under 0.6 confidence, reads as uncertain: no nudge, and the thread is listed as needing your answer.
- After 3 nudges in a row with nothing else reaching the thread, Nudger stops nudging it (gate `nudge-streak`) until something else arrives.

A failed call, a rejected key, exhausted credits or a malformed answer never turns into a blind nudge: the ending is recorded as an error with its reason, the thread's banner says so (for example “Jev is out of credits”), and a key Jev refuses stops all further calls until you save a valid one.

## Your controls

- **Composer eye:** turns nudges off or on for one thread. **Cancel** on a countdown cancels that one nudge.
- **Stop:** pressing Stop holds that thread's nudges until your next message.
- **Pause** (settings page): stops every check and cancels pending nudges; persists across reloads. Resume does not replay missed endings.
- **Automatic continuation** (or **Judge → Off**): turns Nudger off. Saving the same key again keeps it off; saving a new key, or **Turn on**, turns it back on.

A thread whose subthread, workflow or compaction is still running has not really stopped: Nudger neither judges nor nudges it until that work settles (gates `subthread-hold`, `workflow-hold`), and the banner reads “Waiting for its subthreads” or “Waiting for its workflow”. When the last subthread ends, Nudger waits up to 2 minutes for its report before judging the unchanged ending. Startup and resume never replay old endings, and queued Nudger messages are withheld or deleted rather than sent unchecked.

**Safety boundary:** BB's dispatch hook is not an atomic commit fence for Stop/queue races. Nudger rechecks thread state at send time, but it does not claim to solve that upstream limitation, and a Jev verdict never authorizes a new assignment, permission, spend or publication.

## Privacy and cost

Jev receives each eligible **last assistant reply**, plus the questions and model name, over HTTPS at `api.typesafe.ai`; never the rest of the conversation. A reply can still quote code, credentials or other sensitive text, so use Nudger only for work you may share with TypeSafe, and review TypeSafe's own privacy, retention and billing terms. Jev costs $0.042 per million input tokens (output is free); the Nudger page shows an estimate, not a bill or live credit balance.

Nudger keeps its thread inventory and decisions in BB's local plugin storage. Decisions can include reply text, thread and project identifiers, Jev's answers, labels and nudge outcomes for up to 30 days (see [Decision log](#decision-log)). The Nudger page caches displayed titles and obstacle summaries on this device for up to 7 days. Decision exports are local JSONL files and may contain sensitive data: redact before sharing. Your key stays in BB's secret store; Nudger keeps only a SHA-256 digest of it, to tell a new key from one it already saw.

## Nudger page

The **Nudger** destination in BB's navigation rail (`/plugins/nudger/stats`) shows, side by side on wide panes and stacked on narrow ones:

- **Statistics:** nudges and Jev costs per Day (last 14 UTC days), Week (last 12 ISO weeks) or Month (last 6 calendar months); the range choice is remembered on this device. Periods before the first retained record read as “no data yet”, not zero. Jev shows checks, failed checks and input tokens, plus an out-of-credits warning when the newest Jev ending failed for billing.
- **Needs attention:** every current obstacle, newest first: live blockers revalidated against current thread state, plus retained blocker, permission and question reports that no later ending on the same thread has superseded. Selecting one opens the thread.

The page opens on the last stats it showed (kept in memory while BB runs and in this device's local storage for up to 7 days) and replaces them when the fresh read lands: “Updating…” marks cached stats, and a failed read keeps them on screen as “Couldn’t refresh · updated …” with Try again.

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

`continuation`, `decisions` and `verify` never call Jev. `status` reads the same snapshot as the settings page; while Jev is on, that read may re-judge a few retained obstacles judged before the `ending` question existed (at most 5 per read and 25 per process). `verify` validates a stored synthetic validation for the current detector; it is not a safety certification. Only an explicit `bb nudger shadow --confirm-paid-synthetic` runs Jev against the bundled synthetic corpus: it needs the key, makes paid calls and never dispatches project messages. Every Jev call, including errors and synthetic ones, is counted in the per-day ledger.

## Decision log

Nudger keeps why it decided what it did with every observed ending, whatever the action (observed, finished, reported, suppressed, nudged, discarded, error), for **30 days**, so its quality can be studied and improved.

- **Storage.** Each decision is one KV row `recovery.records.<recordId>`; the judged reply (capped at 24,576 characters) is written once beside it at `recovery.text.<recordId>` as Brotli-compressed base64 (`{"br":"…"}`). Rewrites of an unchanged record are skipped.
- **Budget.** Hard caps of 10,000 decisions and 24 MiB (record JSON plus stored text); over either, the oldest decisions are pruned first, and the ones the v1 history view still publishes (each thread's latest, nudges inside the 183-day daily history, the detector's newest outcome, the coverage anchor) go last. Past 30 days only those history-view records remain, without text.
- **Export.** `bb nudger decisions` writes every decision as JSON Lines (one per line) to `--out` (relative to your working directory) or `<BB data dir>/plugins/nudger/exports/decisions-<time>.jsonl`, and prints the path and counts. Over RPC: `nudger_decisions_v1({version:1,cursor:null|string,since?:epochMs})` → `{version:1,decisions,nextCursor}`, oldest first, at most 200 rows/256 KiB per page; the cursor is the last row's `observedAt:id` and stays valid while older rows are pruned.
- **Labels.** `bb nudger label` (or `nudger_label_v1({version:1,recordId,label:"wrong"|null,note?,by})`) marks a decision wrong, or clears it. The label lives on the record, survives restarts and pruning until the record ages out, and is exported, so labelled decisions form a test set.

Each exported decision is a v1 record (`id`, `threadId`, `projectId`, `runId`, `messageId`, `messageRevision`, `observedAt`, `classification`, `action`, `reason`, `detector`, `judgment` with every Jev question's `choice`, `confidence` and `probabilities`) plus:

- `gate`: stable id of what decided `action`, `reason` being its wording. Admission: `pending`, `no-detector`, `paused`, `identities-unavailable`, `policy-changed`, `cancelled-before-classification`, `workflow-hold`, `subthread-hold`, `maintenance`, `restart`. Lifecycle: `superseded`, `operator-stop`, `history-reset`, `thread-archived`, `ineligible`, `not-followable`, `observation-failed`, `detector-changed`, `disposed`, `control-thread`, `stale-ending`. Verdict: `nudge-scheduled`, `check-in-scheduled`, `nudge-streak`, `auto-continue-off`, `finished`, `obstacle`, `obstacle-reported`, `detector-error`, `no-credits`, `key-rejected`, `rejudged`. Null on records from before the log existed.
- `text`, `textTruncated`: the judged reply.
- `nudge`: `{nudgeId, text, scheduledAt, sendAt, state, gate, reason}` for a scheduled nudge: the exact text sent and its fate. Its send-time `gate` is `operator-cancel`, `operator-replied`, `auto-continue-off`, `paused`, `operator-stop`, `superseded`, `fresh-activity`, `active-execution`, `message-changed`, `workflow-hold`, `subthread-hold`, `queued`, `maintenance`, `restart`, `send-failed`, `nudge-cancelled` or `nudge-withheld`; null while pending or once sent.
- `outcome`: what the thread did next within 24 hours, settled once: `next-ending` (`nextRecordId` plus that ending's `classification`/`action` as they settle), `stopped` (a manual Stop), `cancelled` (you cancelled the countdown, turned the thread off, paused, or replied first), or `none` (nothing within 24 hours; filled lazily). Null while the window is open, and on records from before the log existed.
- `label`: `{label:"wrong", note, by, at}` or null.

## License

Copyright 2026 ComicBit. Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE).

The Lucide hand artwork retains its separate ISC/Feather MIT notices in [lucide-LICENSE.txt](lucide-LICENSE.txt).

## For maintainers

### Activation state

Saving a key that differs from the stored value records its digest as pending in KV `jev.key.v1`; the next `configure()` checks it with `GET /v1/models`. A key Jev accepts sets `detector: "jev"` and `enabled: true`, unless it is the key that already did (`activated`), so re-saving a key never overrides a later “off”. A 401/403 marks the key rejected, both on save and from a live call, and revokes the detector. Jev being unreachable leaves the key pending for the next check. Installs upgraded from 0.1.0 never see a save event, so their explicit settings are kept as they are.

### Headquarters integration and migration

Headquarters (plugin ID `orchestrator`) is an optional companion plugin. Nudger discovers it with public `sdk.plugins.list`/`callRpc` and reads `headquarters_controls_v1`, so its control conversations are excluded from judging and continuation; absence, disablement or incompatibility does not gate anything else, and transient failures keep the last known exclusions. Headquarters consumes `nudger_snapshot_v1`, `nudger_history_v1`, `nudger_pause_v1`, `nudger_stats_v1`, `nudger_decisions_v1` and `nudger_label_v1`. Read-only discovery, settings, status, history and stats are open to plugin callers; only native operator clients may change settings, secrets, per-thread toggles or countdown cancellation, and authenticated Headquarters may also forward global pause/resume and read or label decisions.

The public schema/type source is this package's `nudger-contract.ts`, exported as `bb-plugin-nudger/contract` (TypeScript source for `tsx` or BB's bundler, not a plain-Node entry point):

```ts
import { snapshotSchema, type NudgerSnapshot } from "bb-plugin-nudger/contract";
```

When authenticated legacy `nudger_export_v1` is available, Nudger copies recovery, continuation and usage history through that public API, never through private database access. Imported rows are immutable baselines; explicit Nudger values win and counters combine with new deltas without double-counting. Durable checkpoints let migration resume after interruption, and old pending nudges become cancelled diagnostic records, never active timers. Migration never writes BB settings or copies a credential: the operator saves their own key, and that save turns Nudger on. A leftover Luna detector choice from Headquarters reads as off; Luna-era records stay readable.

### Release preparation

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run --ignore-scripts
```

Run these in an isolated checkout without live messages or models. Node tests use the SDK fake host and synthetic TypeSafe HTTP responses; they never hit paid APIs. They cover key activation (fresh install, accepted, rejected, unreachable, re-saved and new keys, upgrades), migration crash/retry/reload, operator and direct BB settings writes, foreign-plugin mutation rejection, passive startup and shutdown, history pagination and digests, control exclusions, native Stop, queued-row ownership, live blocker revalidation, stats, and the workflow/compaction/detector/ledger suite.

The npm package includes its sources, styles and built `dist` artifacts; `prepack` builds them so BB's metadata-stamped server/app bundles ship. Tests and build source maps (which can contain local paths) are excluded.
