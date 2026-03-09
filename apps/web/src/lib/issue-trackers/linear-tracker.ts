// ---------------------------------------------------------------------------
// Linear issue tracker — adapter bridging @orchestrator/tracker-linear
// to the legacy IssueTracker interface (projectPath → config resolution)
// ---------------------------------------------------------------------------

import { LinearTracker } from "@orchestrator/tracker-linear";
import * as store from "@/lib/store";
import type { IssueTracker, TrackerIssue, TrackerComment, TrackerPhase, TrackerTypeSchema } from "./types";

const _linear = new LinearTracker();

// Wire up the team-resolution callback to persist team ID
_linear.onTeamResolved = (_config, teamId) => {
  // This is a best-effort cache; the host stores it back to the instance
  // We need projectPath context here, which we don't have — handled in pollIssues below
};

function resolveConfig(projectPath: string): Record<string, string> | null {
  const { resolveTrackerConfig } = require("./registry");
  const resolved = resolveTrackerConfig(projectPath, "linear") as Record<string, string> | null;
  if (!resolved?.apiKey || (!resolved?.teamId && !resolved?.teamKey)) return null;
  return resolved;
}

// Compat schema: strip `category` to match old TrackerTypeSchema
const linearSchema: TrackerTypeSchema = {
  type: _linear.schema.type,
  displayName: _linear.schema.displayName,
  fields: _linear.schema.fields,
};

export const linearTracker: IssueTracker = {
  name: _linear.name,
  displayName: linearSchema.displayName,
  schema: linearSchema,

  canTransitionState: _linear.canTransitionState,
  canComment: _linear.canComment,
  canDetectWake: _linear.canDetectWake,
  canManageLabels: _linear.canManageLabels,
  canCreateIssue: true,

  async pollIssues(projectPath: string): Promise<TrackerIssue[]> {
    const config = resolveConfig(projectPath);
    if (!config) return [];

    // Wire team resolution to persist back
    _linear.onTeamResolved = (_cfg, teamId) => {
      const trackerConfig = store.getProjectTrackerConfig(projectPath);
      const entry = trackerConfig?.trackers.find((t: store.ProjectTrackerEntry) => t.type === "linear");
      const instance = entry?.instanceId
        ? store.getTrackerInstance(entry.instanceId)
        : store.getDefaultTrackerInstance("linear");
      if (instance) {
        instance.config.teamId = teamId;
        store.saveTrackerInstance(instance);
      }
    };

    return _linear.pollIssues(config);
  },

  async transitionTo(issue: TrackerIssue, phase: TrackerPhase, projectPath: string): Promise<void> {
    const config = resolveConfig(projectPath);
    if (!config) return;
    await _linear.transitionTo!(config, issue, phase);
  },

  async addComment(issue: TrackerIssue, body: string, projectPath: string): Promise<void> {
    const config = resolveConfig(projectPath);
    if (!config) return;
    await _linear.addComment!(config, issue, body);
  },

  getComments(issue: TrackerIssue): Promise<TrackerComment[]> {
    // getComments doesn't need config — reads from _raw
    return _linear.getComments!({}, issue);
  },

  hasLabel(issue: TrackerIssue, label: string): boolean {
    return _linear.hasLabel!(issue, label);
  },

  async reassignOnDone(issue: TrackerIssue, projectPath: string): Promise<void> {
    const config = resolveConfig(projectPath);
    if (!config) return;
    await _linear.reassignOnDone!(config, issue);
  },

  async getIssue(externalId: string, projectPath: string): Promise<TrackerIssue | null> {
    const config = resolveConfig(projectPath);
    if (!config) return null;
    return _linear.getIssue!(config, externalId);
  },

  async createIssue(title: string, description: string, labels: string[], projectPath: string): Promise<{ externalId: string; identifier: string }> {
    const config = resolveConfig(projectPath);
    if (!config) throw new Error("Linear not configured for this project (API Key + Team Key required)");
    return _linear.createIssue!(config, title, description, labels);
  },
};
