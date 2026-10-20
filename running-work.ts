/**
 * Work a root thread started that reports back to it when it ends. While any of it runs, the root
 * has not stopped, so its last reply is neither judged nor nudged.
 *
 * - Workflow steps: BB workflows run each agent step as a hidden thread created by the `workflows`
 *   plugin, owned by the thread that started the workflow (`lifecycleOwnerThreadId`). The owner sits
 *   idle while its steps work, and the workflows plugin messages it when the run finishes. BB's own
 *   `activity.activeWorkflowCount` on the owner stays 0 for these runs, so the steps themselves are
 *   the only signal.
 * - Subthreads: a thread with a `parentThreadId` reports its final response to its parent when it
 *   finishes, which wakes the parent.
 *
 * Nested work reports up the chain (a subthread's subthread, a subthread's workflow), so it counts
 * for the root at the top.
 */
export const WORKFLOWS_PLUGIN_ID = "workflows";

export interface RunningWorkFacts {
  id: string;
  originPluginId: string | null;
  lifecycleOwnerThreadId: string | null;
  parentThreadId: string | null;
  status: string;
  runtime: { displayStatus: string };
  archivedAt: number | string | null;
  deletedAt: number | string | null;
}

/** The thread whose workflow this step belongs to, or null when it is not a workflow step. */
export function workflowOwner(thread: Pick<RunningWorkFacts, "originPluginId" | "lifecycleOwnerThreadId">): string | null {
  return thread.originPluginId === WORKFLOWS_PLUGIN_ID ? thread.lifecycleOwnerThreadId : null;
}

const LIVE_STATES: Record<string, true> = { active: true, starting: true, provisioning: true, stopping: true };

/** Whether a BB thread or runtime status is a live execution state (the dashboard's "working"). */
export function liveExecutionState(status: string): boolean {
  return LIVE_STATES[status] === true;
}

/** A thread is running while BB reports any live execution state for it. */
export function threadRunning(thread: Pick<RunningWorkFacts, "status" | "runtime" | "archivedAt" | "deletedAt">): boolean {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
  return liveExecutionState(thread.status) || liveExecutionState(thread.runtime.displayStatus);
}

/**
 * How long a root whose last running work just ended still counts as waiting. Workflows run steps
 * back to back and then message the owner, and a finished subthread's report takes a moment to
 * start the parent's next turn; this covers those gaps, so the root's last reply is not judged
 * just before the report arrives.
 */
export const SETTLE_MS = 120_000;
