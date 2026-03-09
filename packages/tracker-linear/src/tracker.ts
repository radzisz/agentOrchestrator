// ---------------------------------------------------------------------------
// LinearTracker — implements BaseTracker with config-as-parameter
// ---------------------------------------------------------------------------

import {
  BaseTracker,
  type TrackerIssue,
  type TrackerComment,
  type TrackerPhase,
  type ProviderTypeSchema,
} from "@orchestrator/contracts";
import * as linear from "./linear-api";

function linearStateToPhase(stateName: string): TrackerPhase {
  const lower = stateName.toLowerCase();
  if (["todo", "backlog", "unstarted"].some((s) => lower.includes(s))) return "todo";
  if (lower.includes("in progress")) return "in_progress";
  if (lower.includes("in review")) return "in_review";
  if (lower.includes("done")) return "done";
  if (lower.includes("cancel")) return "cancelled";
  return "todo";
}

function phaseToLinearState(phase: TrackerPhase): string {
  switch (phase) {
    case "todo": return "Todo";
    case "in_progress": return "In Progress";
    case "in_review": return "In Review";
    case "done": return "Done";
    case "cancelled": return "Cancelled";
  }
}

function linearIssueToTracker(issue: linear.LinearIssue): TrackerIssue {
  const comments: TrackerComment[] = (issue.comments?.nodes || [])
    .filter((c) => !c.user.isMe)
    .map((c) => ({
      body: c.body,
      createdAt: c.createdAt,
      authorName: c.user.name,
      isBot: false,
    }));

  return {
    externalId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    phase: linearStateToPhase(issue.state.name),
    rawState: issue.state.name,
    labels: issue.labels.nodes.map((l) => l.name),
    createdBy: issue.creator?.name ?? null,
    createdAt: issue.createdAt ?? null,
    url: issue.url || null,
    source: "linear",
    comments,
    _raw: issue,
  };
}

export const linearSchema: ProviderTypeSchema = {
  type: "linear",
  category: "tracker",
  displayName: "Linear",
  fields: [
    { key: "mode", label: "Integration Mode", type: "select", required: true, default: "poll", options: [
      { label: "Poll", value: "poll" },
      { label: "Webhook", value: "webhook" },
    ] },
    { key: "apiKey", label: "API Key", type: "secret", required: true, description: "Linear API key (lin_api_...)", visibleWhen: { field: "mode", value: "poll" } },
    { key: "pollInterval", label: "Poll Interval", type: "select", default: "60000", visibleWhen: { field: "mode", value: "poll" }, options: [
      { label: "1 minute", value: "60000" },
      { label: "5 minutes", value: "300000" },
      { label: "30 minutes", value: "1800000" },
      { label: "60 minutes", value: "3600000" },
    ] },
    { key: "teamId", label: "Team", type: "string", required: true, projectOverride: true, description: "Linear team ID" },
    { key: "teamKey", label: "Team Key", type: "string", projectOverride: true, description: "Auto-resolved from team selection" },
    { key: "label", label: "Detection Label", type: "string", default: "agent", projectOverride: true, description: "Label to detect agent issues" },
    { key: "previewLabel", label: "Preview Label", type: "string", projectOverride: true, description: "Label for auto-deploy remote preview" },
    { key: "assigneeId", label: "Assignee ID", type: "string", projectOverride: true, description: "Filter by assignee instead of label" },
    { key: "assigneeName", label: "Assignee Name", type: "string", projectOverride: true },
    { key: "detectionMode", label: "Detection Mode", type: "select", default: "label", options: [
      { label: "By Label", value: "label" },
      { label: "By Assignee", value: "assignee" },
    ], projectOverride: true },
    { key: "reassignOnDone", label: "Reassign to creator on done", type: "select", default: "true", options: [
      { label: "Yes", value: "true" },
      { label: "No", value: "false" },
    ], projectOverride: true, visibleWhen: { field: "detectionMode", value: "assignee" } },
    { key: "projectIds", label: "Projects", type: "string", projectOverride: true, description: "Comma-separated Linear project IDs" },
  ],
};

export class LinearTracker extends BaseTracker {
  readonly name = "linear";
  readonly schema = linearSchema;

  override readonly canTransitionState = true;
  override readonly canComment = true;
  override readonly canDetectWake = true;
  override readonly canManageLabels = true;

  /**
   * Optional callback: invoked when team ID is resolved from teamKey,
   * so the host can persist it back to the instance config.
   */
  onTeamResolved?: (config: Record<string, string>, teamId: string) => void;

  async pollIssues(config: Record<string, string>): Promise<TrackerIssue[]> {
    const apiKey = config.apiKey;
    if (!apiKey) return [];

    let teamId = config.teamId;
    if (!teamId) {
      const teamKey = config.teamKey;
      if (!teamKey) return [];
      const team = await linear.resolveTeam(apiKey, teamKey);
      if (!team) return [];
      teamId = team.id;
      this.onTeamResolved?.(config, teamId);
    }

    const detectionMode = config.detectionMode || "label";
    let issues: linear.LinearIssue[];
    if (detectionMode === "assignee" && config.assigneeId) {
      issues = await linear.getAssignedIssues(apiKey, teamId, config.assigneeId);
    } else {
      issues = await linear.getAgentIssues(apiKey, teamId, config.label || "agent");
    }

    return issues.map(linearIssueToTracker);
  }

  override async transitionTo(config: Record<string, string>, issue: TrackerIssue, phase: TrackerPhase): Promise<void> {
    const apiKey = config.apiKey;
    if (!apiKey) return;

    const teamKey = config.teamKey || config.teamId || "";
    const stateName = phaseToLinearState(phase);
    const stateId = await linear.getWorkflowStateId(apiKey, teamKey, stateName);
    if (stateId) {
      await linear.updateIssueState(apiKey, issue.externalId, stateId);
    }
  }

  override async addComment(config: Record<string, string>, issue: TrackerIssue, body: string): Promise<void> {
    const apiKey = config.apiKey;
    if (!apiKey) return;
    await linear.addComment(apiKey, issue.externalId, body);
  }

  override async getComments(_config: Record<string, string>, issue: TrackerIssue): Promise<TrackerComment[]> {
    const raw = issue._raw as linear.LinearIssue;
    return raw.comments.nodes.map((c) => ({
      body: c.body,
      createdAt: c.createdAt,
      authorName: c.user.name,
      isBot: c.user.isMe,
    }));
  }

  override hasLabel(issue: TrackerIssue, label: string): boolean {
    return issue.labels.includes(label);
  }

  override async reassignOnDone(config: Record<string, string>, issue: TrackerIssue): Promise<void> {
    const apiKey = config.apiKey;
    if (!apiKey) return;
    if (config.detectionMode !== "assignee" || config.reassignOnDone === "false") return;

    const raw = issue._raw as linear.LinearIssue;
    const creatorId = raw.creator?.id;
    if (!creatorId) return;
    if (raw.assignee?.id === creatorId) return;

    await linear.updateIssueAssignee(apiKey, issue.externalId, creatorId);
  }

  override async getIssue(config: Record<string, string>, externalId: string): Promise<TrackerIssue | null> {
    const apiKey = config.apiKey;
    if (!apiKey) return null;
    const issue = await linear.getIssue(apiKey, externalId);
    if (!issue) return null;
    return linearIssueToTracker(issue);
  }

  override async createIssue(
    config: Record<string, string>,
    title: string,
    description: string,
    labels: string[],
  ): Promise<{ externalId: string; identifier: string }> {
    const apiKey = config.apiKey;
    if (!apiKey) throw new Error("Linear API key not configured");

    let teamId = config.teamId;
    if (!teamId) {
      const teamKey = config.teamKey;
      if (!teamKey) throw new Error("Linear team not configured");
      const team = await linear.resolveTeam(apiKey, teamKey);
      if (!team) throw new Error(`Could not resolve Linear team: ${teamKey}`);
      teamId = team.id;
      this.onTeamResolved?.(config, teamId);
    }

    // Resolve label IDs
    const labelIds: string[] = [];
    for (const labelName of labels) {
      const id = await linear.getLabelId(apiKey, teamId, labelName);
      if (id) labelIds.push(id);
    }

    const issue = await linear.createIssue(apiKey, teamId, title, description, labelIds);
    return { externalId: issue.id, identifier: issue.identifier };
  }
}
