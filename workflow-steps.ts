/**
 * BB workflows run each agent step as a hidden thread created by the `workflows` plugin, owned by
 * the thread that started the workflow (`lifecycleOwnerThreadId`). The owner sits idle while its
 * steps work, and the workflows plugin messages it when the run finishes.
 *
 * BB's own `activity.activeWorkflowCount` on the owner stays 0 for these runs, so the steps
 * themselves are the only signal.
 */
export const WORKFLOWS_PLUGIN_ID = "workflows";

export interface WorkflowStepFacts {
  id: string;
  originPluginId: string | null;
  lifecycleOwnerThreadId: string | null;
  status: string;
  runtime: { displayStatus: string };
  archivedAt: number | string | null;
  deletedAt: number | string | null;
}

/** The thread whose workflow this step belongs to, or null when it is not a workflow step. */
export function workflowOwner(thread: Pick<WorkflowStepFacts, "originPluginId" | "lifecycleOwnerThreadId">): string | null {
  return thread.originPluginId === WORKFLOWS_PLUGIN_ID ? thread.lifecycleOwnerThreadId : null;
}

const LIVE_STATES: Record<string, true> = { active: true, starting: true, provisioning: true, stopping: true };

/** Whether a BB thread or runtime status is a live execution state (the dashboard's "working"). */
export function liveExecutionState(status: string): boolean {
  return LIVE_STATES[status] === true;
}

/** A step is running while BB reports any live execution state for it. */
export function workflowStepRunning(thread: Pick<WorkflowStepFacts, "status" | "runtime" | "archivedAt" | "deletedAt">): boolean {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
  return liveExecutionState(thread.status) || liveExecutionState(thread.runtime.displayStatus);
}

/**
 * How long an owner whose last running step just ended still counts as waiting. Workflows run
 * steps back to back and then message the owner; this covers the gap between steps and the
 * finishing notification, so the owner's last reply is not judged mid-workflow.
 */
export const WORKFLOW_SETTLE_MS = 120_000;
