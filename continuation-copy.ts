/** Every word the operator sees about automatic continuation, and how each internal reason reads to them. */
/** One status line: a primary phrase, then a quieter detail. */
export interface Line { text: string; detail: string | null }

const line = (text: string, detail: string | null = null): Line => ({ text, detail });

/** Detector error for a Jev call TypeSafe refused for billing (HTTP 402): the organization has no credits left. */
export const JEV_NO_CREDITS = "Jev is out of TypeSafe credits";
/** That failure, including records stored before it had its own message ("…failed with HTTP 402"). */
export const isNoCreditsError = (reason: string) => reason.includes(JEV_NO_CREDITS) || reason.includes("Jev evaluation failed with HTTP 402");
const NOT_SENT = "No nudge sent";
const ATTENTION = "Added to Needs your attention";

/** Status lines the composer banner shows. */
export const LINE = {
  watchingRun: line("Watching", "I'll check the reply when the agent stops"),
  watchingNext: line("Watching", "I'll check the next reply"),
  reading: line("Reading the reply…"),
  nudging: line("Continuing…"),
  nudged: line("Nudged to continue"),
  nudgedWatching: line("Nudged to continue", "Watching"),
  finished: line("Agent finished"),
  blocker: line("The agent is stuck.", ATTENTION),
  permission: line("The agent needs a permission.", ATTENTION),
  uncertainty: line("The agent needs your answer.", ATTENTION),
  replied: line("You replied", NOT_SENT),
  cancelled: line("Nudge cancelled"),
  stopExclusion: line("Paused after Stop", "Your next message turns it back on"),
  newRun: line("A new run started", NOT_SENT),
  movedOn: line("The conversation moved on", NOT_SENT),
  busy: line("The agent was busy", NOT_SENT),
  stopPressed: line("You pressed Stop", NOT_SENT),
  lastSecond: line("Something changed at the last second", NOT_SENT),
  paused: line("Auto-continue paused", "Paused for every thread from the dashboard"),
  noDetector: line("Auto-continue isn't set up", "Choose a detector in Nudger settings"),
  readError: line("Couldn't read the reply", NOT_SENT),
  noCredits: line("Jev is out of credits", "Add TypeSafe credits; no nudge sent"),
  notFollowable: line("Can't follow this run", "It won't be nudged"),
  compacting: line("Compacting the conversation", "I'll check the last reply after"),
  compacted: line("The conversation was compacted", NOT_SENT),
  workflowRan: line("Its workflow was running", NOT_SENT),
} as const satisfies Record<string, Line>;

/** The thread waits on the workflow it started: its steps, then a short settle before its last reply is checked. */
export function workflowLine(running: number): Line {
  return line("Waiting for its workflow", running === 0 ? "Finishing up" : running === 1 ? "1 step running" : `${running} steps running`);
}

export function countdownLine(seconds: number): Line {
  return line(`Continuing in ${seconds}s`, "The agent stopped before finishing");
}

/** A line as one sentence pair, for places with a single text slot. */
export function lineText({ text, detail }: Line): string {
  return detail === null ? text : `${text.replace(/[.…]$/, "")}. ${detail}`;
}

/** Labels and controls. */
export const COPY = {
  cancel: "Cancel",
  toggleOn: "Auto-continue on. Turn off for this thread",
  toggleOff: "Auto-continue off. Turn on for this thread",
  everyThread: "Auto-continue is on for every thread",
  everyThreadRule: "Each thread's eye toggles it; your message, Stop or Cancel suppress pending continuation.",
} as const;

/** Accessible name and tooltip for the banner's nudge counter. */
export function nudgeCountLabel(count: number): string {
  return count === 1 ? "Nudger nudged this chat once" : `Nudger nudged this chat ${count} times`;
}

/** Internal reasons a pending nudge is cancelled with (logged, never shown verbatim). */
export const CANCEL_REASON = {
  countdown: "cancelled from the countdown",
  turnedOff: "turned off",
  paused: "auto-continue paused",
  stop: "manual Stop observed",
  stopping: "thread entered stopping",
  superseded: "superseded by a newer classified ending",
  restarted: "plugin restarted",
  /** Followed by `: <initiator>` of the dispatch that cancelled it. */
  freshActivity: "fresh activity before admission",
  /** Followed by `: <error>`. */
  sendFailed: "send failed",
  /** A `/compact` maintenance turn started; the ending is checked again after it. */
  maintenance: "the conversation started compacting",
} as const;

/** Internal reasons the dispatch hook withholds a nudge with at send time. */
export const WITHHELD_REASON = {
  stop: "a manual Stop was observed",
  newerRun: "a newer root turn superseded the classified ending",
  messageChanged: "the final assistant message changed after classification",
  /** Followed by `: <thread status>`. */
  notIdle: "the thread is not idle",
  joinTurn: "the attempt would join a running turn",
  queued: "core queued the continuation instead of starting it",
  /** The thread's workflow steps are running (or only just finished). */
  workflow: "its workflow is still running",
} as const;

/** Recovery holds a live ending unjudged with these reasons, then checks it once nothing holds it. */
export const HELD_REASON = {
  workflow: "Waiting for its workflow; the ending is checked once its steps finish",
  maintenance: "Held while the conversation compacts; the ending is checked after",
} as const;

export function cancelledCopy(reason: string | null): Line {
  if (reason === `${CANCEL_REASON.freshActivity}: user`) return LINE.replied;
  if (reason?.startsWith(CANCEL_REASON.freshActivity)) return LINE.movedOn;
  if (reason === CANCEL_REASON.countdown || reason === CANCEL_REASON.turnedOff || reason === CANCEL_REASON.paused) return LINE.cancelled;
  if (reason === CANCEL_REASON.stop || reason === CANCEL_REASON.stopping) return LINE.stopPressed;
  if (reason === CANCEL_REASON.superseded) return LINE.newRun;
  if (reason === CANCEL_REASON.maintenance) return LINE.compacted;
  return LINE.lastSecond;
}

export function withheldCopy(reason: string | null): Line {
  if (reason === WITHHELD_REASON.stop) return LINE.stopPressed;
  if (reason === WITHHELD_REASON.newerRun || reason === WITHHELD_REASON.messageChanged) return LINE.movedOn;
  if (reason === WITHHELD_REASON.joinTurn || reason === WITHHELD_REASON.queued || reason?.startsWith(WITHHELD_REASON.notIdle)) return LINE.busy;
  if (reason === WITHHELD_REASON.workflow) return LINE.workflowRan;
  return LINE.lastSecond;
}

/** The message BB shows in the chat when the dispatch hook rejects one of this plugin's nudges. */
export function nudgeRejectMessage(reason: string): string {
  const text = withheldCopy(reason).text.replace(/\.$/, "");
  return `Nudger didn't send its nudge: ${text[0]!.toLowerCase()}${text.slice(1)}.`;
}

// Recovery's internal record reasons, by prefix.
const SUPPRESSED: Array<[prefix: string, copy: Line]> = [
  ["Observed manual Stop", LINE.stopPressed],
  ["A later root execution superseded", LINE.newRun],
  ["Root history was cleared or compacted", LINE.movedOn],
  ["The observed root ending is no longer current", LINE.movedOn],
  ["Lifecycle or final-message evidence changed", LINE.movedOn],
  ["Classification result canceled while", LINE.movedOn],
  ["Classification routing canceled by newer", LINE.movedOn],
  [HELD_REASON.workflow, LINE.workflowRan],
  [HELD_REASON.maintenance, LINE.compacted],
  // The reply ended unread or while auto-continue was off; the thread is watched again now.
  ["Continuation candidate classified, but", LINE.watchingNext],
  ["Passive classification paused", LINE.watchingNext],
  ["Classification paused or policy changed", LINE.watchingNext],
  ["No operational detector selected", LINE.watchingNext],
  ["Classification was canceled before it began", LINE.watchingNext],
  ["Prior process observation retained", LINE.watchingNext],
  ["Recovery observer disposed", LINE.watchingNext],
  ["Incremental public history exceeded", LINE.notFollowable],
  ["Thread observation failed", LINE.readError],
  ["Owned control-role identities became unavailable", LINE.readError],
];

/** Unknown and legacy reasons say nothing about a withheld nudge; the thread is simply watched again. */
export function suppressedCopy(reason: string): Line {
  // Recovery's own record of a nudge that was cancelled or withheld while scheduling.
  const nudge = /^Continuation (cancelled|withheld): (.*)$/s.exec(reason);
  if (nudge) return nudge[1] === "withheld" ? withheldCopy(nudge[2]!) : cancelledCopy(nudge[2]!);
  return SUPPRESSED.find(([prefix]) => reason.startsWith(prefix))?.[1] ?? LINE.watchingNext;
}
