Watch native BB threads, see what needs attention, and optionally let an assistant continue unfinished work with guarded `please continue` messages. Nudger is standalone: Headquarters, Hermes, and a machine connection are not required.

Requires BB >=0.46 and Plugin SDK >=0.6.39. Package: `bb-plugin-nudger`; installed ID: `nudger`; CLI: `bb nudger`. Source installation and developer details are in README.md.

## Safe default: observe only

The detector defaults to **None — observe only**. Inventory, composer banners, and local statistics need no API key, make no model calls, and send no automatic messages. Adding a key or importing legacy settings does not enable Jev; select it explicitly.

## Enable Jev (optional paid service)

1. Create or sign in to **your own TypeSafe account** at [console.typesafe.ai](https://console.typesafe.ai), obtain your own API key, and arrange credits/billing there. No account, key, or credits are bundled.
2. Open **Settings → Installed plugins → Nudger** in BB.
3. Enter the key in the **TypeSafe API key** secret setting. Never put it in a chat or source file.
4. Explicitly choose **Detector → Jev — TypeSafe API**. **Enable automatic continuation** must be on for classification and dispatch.

A missing/invalid key, exhausted credits, service error, or malformed judgment does **not** trigger a blind continuation. The affected ending stays gated or becomes an error. There is no fallback detector. Only newly observed eligible live endings are checked; startup/resume do not replay a backlog.

## Controls and safety

The composer eye toggles continuation for one thread; countdown Cancel cancels one decision. Global disable keeps passive observation running. Pause classification persists and cancels pending nudges. Native Stop stays suppressive until admitted human work re-arms the thread.

Jev checks the final assistant message as untrusted data. Requests to the operator are never automatically continued. Eligible unfinished assistant work gets a 20-second countdown. Work already running in a delegated task gets a check-in after 30 minutes, doubling for unanswered nudges. New activity cancels the timer; three unanswered nudges suppress further continuation until something else arrives.

Running subthreads, workflows, and compaction hold continuation. Dispatch rechecks current thread state; queued owned messages are withheld/deleted rather than sent unchecked. A model verdict cannot authorize a new assignment, permission, spend, or publication. BB's dispatch hook is not an atomic core fence for Stop/queue races; Nudger does not claim to remove that upstream limitation.

## Privacy and cost

Jev sends eligible **final assistant messages** and classification questions over HTTPS to TypeSafe (`api.typesafe.ai`), not the full thread history. Final replies may still quote sensitive data. Enable it only for data you may share externally, and review TypeSafe's own privacy, retention, and billing terms. Calls may incur charges; Nudger's cost estimate is not a bill or live credit balance.

Local decision logs can contain message text, identifiers, judgments, and labels for up to 30 days, subject to storage caps; selected history/counts remain longer. The Stats page shows nudges, estimated Jev usage/cost, and attention items, caching displayed titles/summaries on this device for up to 7 days. JSONL exports may contain sensitive information: redact before sharing.

## Optional Headquarters integration

Public versioned RPC excludes Headquarters control threads and shares snapshots/history without exposing settings or keys. Legacy migration is copy-only: it never activates old timers, enables paid classification, or copies credentials. No private database access is required. Integrators import the single schema/type source from `bb-plugin-nudger/contract` (TypeScript source for `tsx`/BB bundling).
