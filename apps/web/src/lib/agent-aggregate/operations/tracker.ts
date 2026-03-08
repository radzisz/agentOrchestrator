// ---------------------------------------------------------------------------
// Tracker operations — uses the issue tracker abstraction exclusively.
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import { getTracker } from "@/lib/issue-trackers/registry";
import { Issue } from "@/lib/issue-trackers/types";
import type { AgentState } from "../types";

/** Helper: set both trackerStatus and linearStatus for backward compat. */
function setTrackerStatus(state: AgentState, value: AgentState["trackerStatus"]): void {
  state.trackerStatus = value;
  state.linearStatus = value;
}

/** Resolve an Issue instance for an agent's tracked issue. */
async function resolveIssue(agent: store.AgentData, projectPath: string): Promise<Issue | null> {
  const source = agent.trackerSource || "linear";
  const tracker = getTracker(source);
  const externalId = agent.trackerExternalId || agent.linearIssueUuid;
  if (!tracker || !externalId || !tracker.getIssue) return null;

  const data = await tracker.getIssue(externalId, projectPath);
  if (!data) return null;
  return new Issue(data, tracker, projectPath);
}

/** Close the issue (set status to Done). */
export async function closeIssue(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
  mergeMessage?: string,
): Promise<void> {
  const issue = await resolveIssue(agent, projectPath);
  if (issue) {
    if (mergeMessage) await issue.addComment(mergeMessage);
    await issue.transitionTo("done");
  }

  setTrackerStatus(state, "done");
}

/** Cancel the issue (set status to Cancelled). */
export async function cancelIssue(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
  reason?: string,
): Promise<void> {
  const issue = await resolveIssue(agent, projectPath);
  if (issue) {
    if (reason) await issue.addComment(reason);
    await issue.transitionTo("cancelled");
  }

  setTrackerStatus(state, "cancelled");
}
