---
name: nudger
description: Inspect or configure BB Nudger, which nudges agents that stopped with unfinished work after Jev judges their last reply; continuation controls, key status, decisions and Jev usage.
---

# Nudger

Nudger (installed ID `nudger`) watches BB threads. When an agent stops, TypeSafe's Jev judges the last reply: unfinished work the agent can do itself gets a `please continue` after a 20-second countdown; a blocker, a request for permission or a decision, or an uncertain judgment is shown to the operator and never continued; finished work is left alone.

Start with `bb nudger status`. `bb nudger continuation <threadId>` reads one thread's current state and lifetime nudge count. Only on the operator's explicit request, `bb nudger continuation <threadId> off` or `on` changes that thread. Settings → Installed plugins → Nudger holds the Jev API key, Automatic continuation, Judge, the key status (Connected, Key rejected, Couldn't check the key) and Pause; the Nudger navigation page shows nudges, estimated Jev cost and every thread needing attention.

Activation: with no key Nudger judges nothing and sends nothing. Saving a new key checks it with one free `GET /v1/models` call; a key Jev accepts turns Nudger on (Judge → Jev, Automatic continuation on). Re-saving the key that already did so never overrides the operator's later "off"; a new key or Turn on does. A key Jev refuses, on save or on a live call, stops all Jev calls until a valid key is saved. Never ask for a key in chat; request secure entry in Nudger's secret setting. Do not turn Nudger on, disable Stop suppression, or change another thread's preference without the operator's request.

`bb nudger verify` reads the stored synthetic validation for the current detector and is not a safety certification. Only `bb nudger shadow --confirm-paid-synthetic` runs the paid synthetic Jev validation; do not run it as a smoke check or to investigate a failure without authorization.

Nudger keeps a 30-day decision log: every ending's judged text, Jev's answers, the deciding gate, the nudge sent and what the thread did next. `bb nudger decisions [--since <date>] [--out <path>]` exports it as JSONL (read-only, no model call). When the operator says a decision was wrong, `bb nudger label '<recordId>' wrong --by <name> [--note <why>]` records it (`clear` removes it); labelled decisions become the test set for improving Nudger.

Continuation resumes unfinished already-authorized work, never a new assignment, permission, human decision, spend or publication. Stock dispatch hooks are not an atomic final-commit Stop/queue fence. Jev's judgment is a heuristic; no command or report removes that limitation. Startup never catches up on missed endings.

If the Headquarters plugin (`orchestrator`) is installed, its control conversations are excluded and it reads Nudger's public snapshots; it can only forward global pause/resume. Never read private BB databases or print a key.
