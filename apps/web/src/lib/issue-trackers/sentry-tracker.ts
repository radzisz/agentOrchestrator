// ---------------------------------------------------------------------------
// Sentry issue tracker — adapter bridging @orchestrator/tracker-sentry
// to the legacy IssueTracker interface (projectPath → config resolution)
// ---------------------------------------------------------------------------

import { SentryTracker, sentryApi as sentry } from "@orchestrator/tracker-sentry";
export { buildSentryIdentifier } from "@orchestrator/tracker-sentry";
import type { IssueTracker, TrackerIssue, TrackerPhase, TrackerTypeSchema } from "./types";

const _sentry = new SentryTracker();

function resolveConfig(projectPath: string): Record<string, string> | null {
  const { resolveTrackerConfig } = require("./registry");
  const resolved = resolveTrackerConfig(projectPath, "sentry") as Record<string, string> | null;
  if (!resolved?.authToken || !resolved?.org) return null;

  const mode = resolved.mode || "both";
  if (mode === "webhook") return null;
  const projects = resolved.projects;
  if (!projects) return null;
  const projectList = projects.split(",").map((s: string) => s.trim()).filter(Boolean);
  if (projectList.length === 0) return null;

  return resolved;
}

function formatEventSummary(ev: sentry.SentryEventSummary): string {
  const parts: string[] = [];

  if (ev.url) parts.push(`**URL:** ${ev.url}`);
  if (ev.environment) parts.push(`**Environment:** ${ev.environment}`);
  if (ev.browser) parts.push(`**Browser:** ${ev.browser}`);
  if (ev.transaction) parts.push(`**Transaction:** ${ev.transaction}`);

  for (const exc of ev.exceptions) {
    parts.push("", `**${exc.type}:** ${exc.value}`);
    if (exc.frames.length > 0) {
      parts.push("", "**Stacktrace (in-app frames):**", "```");
      for (const f of exc.frames) parts.push(f);
      parts.push("```");
    }
  }

  if (ev.breadcrumbs.length > 0) {
    parts.push("", "**Breadcrumbs:**");
    for (const b of ev.breadcrumbs) parts.push(`- ${b}`);
  }

  return parts.join("\n");
}

// Compat schema
const sentrySchema: TrackerTypeSchema = {
  type: _sentry.schema.type,
  displayName: _sentry.schema.displayName,
  fields: _sentry.schema.fields,
};

export const sentryTracker: IssueTracker = {
  name: _sentry.name,
  displayName: sentrySchema.displayName,
  schema: sentrySchema,

  canTransitionState: _sentry.canTransitionState,
  canComment: false,
  canDetectWake: false,
  canManageLabels: false,

  async pollIssues(projectPath: string): Promise<TrackerIssue[]> {
    const config = resolveConfig(projectPath);
    if (!config) return [];

    // Use the package for basic polling, but enrich with event summaries
    const issues = await _sentry.pollIssues(config);

    // Enrich descriptions with event summaries
    const authToken = config.authToken;
    const org = config.org;
    if (authToken && org) {
      for (const issue of issues) {
        try {
          const ev = await sentry.getLatestEventSummary(authToken, org, issue.externalId);
          if (ev) {
            issue.description = (issue.description || "") + "\n\n" + formatEventSummary(ev);
          }
        } catch {}
      }
    }

    return issues;
  },

  async transitionTo(issue: TrackerIssue, phase: TrackerPhase, projectPath: string): Promise<void> {
    const config = resolveConfig(projectPath);
    if (!config) return;
    await _sentry.transitionTo!(config, issue, phase);
  },

  async getIssue(externalId: string, projectPath: string): Promise<TrackerIssue | null> {
    const config = resolveConfig(projectPath);
    if (!config) return null;
    const issue = await _sentry.getIssue!(config, externalId);
    if (!issue) return null;

    // Enrich with event summary
    const authToken = config.authToken;
    const org = config.org;
    if (authToken && org) {
      try {
        const ev = await sentry.getLatestEventSummary(authToken, org, externalId);
        if (ev) {
          issue.description = (issue.description || "") + "\n\n" + formatEventSummary(ev);
        }
      } catch {}
    }

    return issue;
  },
};
