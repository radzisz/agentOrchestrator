// ---------------------------------------------------------------------------
// Linear operations — extracted from merge.ts, dispatcher.ts
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import * as linear from "@/services/linear";
import type { AgentState } from "../types";

/** Close the Linear issue (set status to Done). */
export async function closeLinearIssue(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
  mergeMessage?: string,
): Promise<void> {
  const cfg = store.getProjectConfig(projectPath);
  if (!agent.linearIssueUuid || !cfg.LINEAR_API_KEY) return;

  if (mergeMessage) {
    await linear.addComment(cfg.LINEAR_API_KEY, agent.linearIssueUuid, mergeMessage);
  }

  const doneId = await linear.getWorkflowStateId(
    cfg.LINEAR_API_KEY,
    cfg.LINEAR_TEAM_KEY,
    "Done",
  );
  if (doneId) {
    await linear.updateIssueState(cfg.LINEAR_API_KEY, agent.linearIssueUuid, doneId);
  }

  state.linearStatus = "done";
}

/** Cancel the Linear issue (set status to Cancelled). */
export async function cancelLinearIssue(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
  reason?: string,
): Promise<void> {
  const cfg = store.getProjectConfig(projectPath);
  if (!agent.linearIssueUuid || !cfg.LINEAR_API_KEY) return;

  if (reason) {
    await linear.addComment(cfg.LINEAR_API_KEY, agent.linearIssueUuid, reason);
  }

  const cancelId = await linear.getWorkflowStateId(
    cfg.LINEAR_API_KEY,
    cfg.LINEAR_TEAM_KEY,
    "Cancelled",
  );
  if (cancelId) {
    await linear.updateIssueState(cfg.LINEAR_API_KEY, agent.linearIssueUuid, cancelId);
  }

  state.linearStatus = "cancelled";
}
