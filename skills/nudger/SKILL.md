---
name: nudger
description: Inspect or configure BB Nudger's final-reply watcher, continuation controls, detector gates and retained usage without requiring Headquarters.
---

# Nudger

Nudger is a standalone plugin with installed ID `nudger`. Headquarters is optional. The detector, secret, global pause, per-thread eyes and retained continuation history belong to Nudger's own settings, never to Headquarters.

Start with `bb nudger status`. `bb nudger continuation <threadId>` reads the known thread's current admission state and lifetime nudge count. With an explicit operator request, `bb nudger continuation <threadId> off` or `on` changes that thread only. Settings → Installed plugins → Nudger provides the global detector, enablement and pause controls; the Nudger navigation page shows nudge and Jev cost statistics plus every current obstacle. Do not turn on a paid/external detector, disable Stop suppression, or change another thread's continuation preference without the operator's request.

Fresh installs effectively select no detector. Observation and banners are passive. Jev is the only detector: it requires a secret TypeSafe key and sends only eligible final assistant replies to TypeSafe; it needs no machine or Hermes. Luna was removed; a leftover Luna choice reads as none with the gate "Luna was removed; select Jev". A missing key remains an explicit gate; never substitute a detector.

`bb nudger verify` reads the stored exact-detector synthetic validation and is not a safety certification. Only `bb nudger shadow --confirm-paid-synthetic` starts the paid synthetic Jev validation; it requires the TypeSafe key. Do not run it as a smoke check or to investigate a reported failure without authorization.

Nudger keeps a 30-day decision log: every ending's judged text, Jev's answers, the deciding gate, the nudge sent and what the thread did next. `bb nudger decisions [--since <date>] [--out <path>]` exports it as JSONL (read-only, no model call). When the operator says a decision was wrong, `bb nudger label '<recordId>' wrong --by <name> [--note <why>]` records it (`clear` removes it); labelled decisions become the test set for improving Nudger.

Continuation resumes unfinished already-authorized work, never a new assignment, permission, human decision, spend or publication. Stock dispatch hooks are not an atomic final-commit Stop/queue fence. Model output is a heuristic; no command or report removes that limitation. Startup never catches up on missed endings, and pending legacy timers are never replayed.

Headquarters discovery uses the stable peer ID `orchestrator` and public versioned RPC. Current peer control conversations are excluded. Legacy import is non-destructive and authenticated: imported rows are immutable baselines, explicit own preferences win, and counts combine with own deltas. The imported detector choice is setup information only; migration never enables paid classification or copies a credential. To use Jev, request secure key entry in Nudger's public secret field followed by explicit Jev selection. Headquarters' source encrypted credential stays untouched. Never read private BB databases or print a key. Plugin callers cannot mutate settings, per-thread toggles or countdown cancellation; Headquarters can only forward global pause/resume.
