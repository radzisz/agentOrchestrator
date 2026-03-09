// ---------------------------------------------------------------------------
// Tracker operations — uses the issue tracker abstraction exclusively.
// NO direct linearApi / sentryApi calls — always go through IssueTracker.
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import { getTracker } from "@/lib/issue-trackers/registry";
import { Issue } from "@/lib/issue-trackers/types";
import type { TrackerIssue } from "@/lib/issue-trackers/types";
import type { AgentState } from "../types";

/** Helper: set both trackerStatus and linearStatus for backward compat. */
function setTrackerStatus(state: AgentState, value: AgentState["trackerStatus"]): void {
  state.trackerStatus = value;
  state.linearStatus = value;
}

/** Resolve an Issue instance for an agent's tracked issue. */
export async function resolveIssue(agent: store.AgentData, projectPath: string): Promise<Issue | null> {
  const source = agent.trackerSource || "linear";
  const tracker = getTracker(source);
  const externalId = agent.trackerExternalId || agent.linearIssueUuid;
  if (!tracker || !externalId || !tracker.getIssue) return null;

  const data = await tracker.getIssue(externalId, projectPath);
  if (!data) return null;
  return new Issue(data, tracker, projectPath);
}

/** Fetch a TrackerIssue by source and externalId through the abstraction. */
export async function fetchIssue(
  source: string,
  externalId: string,
  projectPath: string,
): Promise<TrackerIssue | null> {
  const tracker = getTracker(source);
  if (!tracker?.getIssue) return null;
  return tracker.getIssue(externalId, projectPath);
}

/** Add a comment to the agent's tracked issue. Best-effort, no throw. */
export async function addComment(
  agent: store.AgentData,
  projectPath: string,
  body: string,
): Promise<void> {
  try {
    const issue = await resolveIssue(agent, projectPath);
    if (issue) await issue.addComment(body);
  } catch {
    // best effort
  }
}

/** Transition the agent's tracked issue to a given phase. Best-effort, no throw. */
export async function transitionTo(
  agent: store.AgentData,
  projectPath: string,
  phase: "todo" | "in_progress" | "in_review" | "done" | "cancelled",
): Promise<void> {
  try {
    const issue = await resolveIssue(agent, projectPath);
    if (issue) await issue.transitionTo(phase);
  } catch {
    // best effort
  }
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
