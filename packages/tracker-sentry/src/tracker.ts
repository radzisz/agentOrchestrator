// ---------------------------------------------------------------------------
// SentryTracker — implements BaseTracker with config-as-parameter
// ---------------------------------------------------------------------------

import {
  BaseTracker,
  type TrackerIssue,
  type TrackerPhase,
  type ProviderTypeSchema,
} from "@orchestrator/contracts";
import * as sentry from "./sentry-api";

function autoShortName(slug: string): string {
  return slug.split("-").map((w) => w[0]).join("").toUpperCase();
}

function extractSequence(shortId: string, projectSlug: string): string {
  const prefix = projectSlug.toUpperCase() + "-";
  if (shortId.startsWith(prefix)) return shortId.slice(prefix.length);
  const lastDash = shortId.lastIndexOf("-");
  return lastDash >= 0 ? shortId.slice(lastDash + 1) : shortId;
}

function parseShortNames(raw?: string): Record<string, string> {
  if (!raw) return {};
  const map: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [slug, short] = part.split(":").map((s) => s.trim());
    if (slug && short) map[slug] = short;
  }
  return map;
}

function buildIdentifier(issue: sentry.SentryIssue, shortNames: Record<string, string>): string {
  const slug = issue.project?.slug || "unknown";
  const short = shortNames[slug] || autoShortName(slug);
  const seq = extractSequence(issue.shortId, slug);
  return `${short}-${seq}`;
}

export function buildSentryIdentifier(
  shortId: string,
  projectSlug: string,
  projectShortNamesRaw?: string,
): string {
  const shortNames = parseShortNames(projectShortNamesRaw);
  const short = shortNames[projectSlug] || autoShortName(projectSlug);
  const seq = extractSequence(shortId, projectSlug);
  return `${short}-${seq}`;
}

function sentryStatusToPhase(status: string): TrackerPhase {
  switch (status) {
    case "resolved": return "done";
    case "ignored": return "cancelled";
    default: return "todo";
  }
}

function phaseToSentryStatus(phase: TrackerPhase): "resolved" | "ignored" | "unresolved" | null {
  switch (phase) {
    case "done": return "resolved";
    case "cancelled": return "ignored";
    case "todo": return "unresolved";
    default: return null;
  }
}

function formatEventSummary(ev: sentry.SentryEventSummary): string {
  const parts: string[] = [];

  if (ev.url) parts.push(`**URL:** ${ev.url}`);
  if (ev.environment) parts.push(`**Environment:** ${ev.environment}`);
  if (ev.browser) parts.push(`**Browser:** ${ev.browser}`);

  for (const exc of ev.exceptions) {
    parts.push("", `### ${exc.type}: ${exc.value}`, "");
    if (exc.frames.length > 0) {
      parts.push("```");
      parts.push(...exc.frames);
      parts.push("```");
    }
  }

  if (ev.breadcrumbs.length > 0) {
    parts.push("", "### Breadcrumbs", "");
    for (const b of ev.breadcrumbs) {
      parts.push(`- ${b}`);
    }
  }

  return parts.join("\n");
}

function sentryIssueToTracker(
  issue: sentry.SentryIssue,
  shortNames: Record<string, string> = {},
  eventSummary?: sentry.SentryEventSummary | null,
): TrackerIssue {
  const sentryUrl = issue.permalink || `https://sentry.io/issues/${issue.id}/`;
  const description = [
    `**Sentry Issue**`,
    "",
    `**Project:** ${issue.project?.slug || "unknown"}`,
    `**Level:** ${issue.level || "error"}`,
    `**Events:** ${issue.count || 1}`,
    `**Users affected:** ${issue.userCount || "?"}`,
    "",
    issue.culprit ? `**Culprit:** \`${issue.culprit}\`` : "",
    "",
    sentryUrl ? `[View in Sentry](${sentryUrl})` : "",
    "",
    "---",
    "",
    issue.metadata?.value || issue.metadata?.message || "",
    ...(eventSummary ? ["", "---", "", formatEventSummary(eventSummary)] : []),
  ].filter(Boolean).join("\n");

  return {
    externalId: issue.id,
    identifier: buildIdentifier(issue, shortNames),
    title: `[Sentry] ${issue.title}`,
    description,
    priority: issue.level === "fatal" ? 1 : issue.level === "error" ? 2 : 3,
    phase: sentryStatusToPhase(issue.status),
    rawState: issue.status,
    labels: [],
    createdBy: null,
    createdAt: issue.firstSeen ?? null,
    url: sentryUrl,
    source: "sentry",
    comments: [],
    _raw: issue,
  };
}

export const sentrySchema: ProviderTypeSchema = {
  type: "sentry",
  category: "tracker",
  displayName: "Sentry",
  fields: [
    { key: "mode", label: "Integration Mode", type: "select", required: true, default: "poll", options: [
      { label: "Poll", value: "poll" },
      { label: "Webhook", value: "webhook" },
    ] },
    { key: "authToken", label: "Auth Token", type: "secret", required: true, description: "Required scopes: project:read, project:write, org:read, event:read", visibleWhen: { field: "mode", value: "poll" } },
    { key: "pollInterval", label: "Poll Interval", type: "select", default: "300000", visibleWhen: { field: "mode", value: "poll" }, options: [
      { label: "1 minute", value: "60000" },
      { label: "5 minutes", value: "300000" },
      { label: "30 minutes", value: "1800000" },
      { label: "60 minutes", value: "3600000" },
    ] },
    { key: "org", label: "Organization", type: "string", required: true, projectOverride: true, description: "Sentry organization slug" },
    { key: "projects", label: "Sentry Projects", type: "string", projectOverride: true, description: "Comma-separated project slugs" },
    { key: "projectShortNames", label: "Project Short Names", type: "string", projectOverride: true, description: "Optional short names: slug:SHORT,slug2:AB (auto-generated from first letters if empty)" },
  ],
};

export class SentryTracker extends BaseTracker {
  readonly name = "sentry";
  readonly schema = sentrySchema;

  override readonly canTransitionState = true;

  async pollIssues(config: Record<string, string>): Promise<TrackerIssue[]> {
    const authToken = config.authToken;
    const org = config.org;
    const mode = config.mode || "both";
    if (!authToken || !org || mode === "webhook") return [];

    const projects = config.projects
      ? config.projects.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    if (projects.length === 0) return [];

    const shortNames = parseShortNames(config.projectShortNames);
    const results: TrackerIssue[] = [];

    for (const slug of projects) {
      try {
        const issues = await sentry.listIssues(authToken, org, slug);
        for (const issue of issues) {
          if (issue.status === "resolved" || issue.status === "ignored") continue;
          const ev = await sentry.getLatestEventSummary(authToken, org, issue.id).catch(() => null);
          results.push(sentryIssueToTracker(issue, shortNames, ev));
        }
      } catch (error) {
        console.error(`[sentry-tracker] poll error for ${slug}:`, error);
      }
    }

    return results;
  }

  override async transitionTo(config: Record<string, string>, issue: TrackerIssue, phase: TrackerPhase): Promise<void> {
    const authToken = config.authToken;
    if (!authToken) return;

    const sentryStatus = phaseToSentryStatus(phase);
    if (!sentryStatus) return;

    await sentry.updateIssueStatus(authToken, issue.externalId, sentryStatus);
  }

  override async getIssue(config: Record<string, string>, externalId: string): Promise<TrackerIssue | null> {
    const authToken = config.authToken;
    const org = config.org;
    if (!authToken) return null;

    const issue = await sentry.getIssue(authToken, externalId);
    if (!issue) return null;
    const shortNames = parseShortNames(config.projectShortNames);
    const ev = org ? await sentry.getLatestEventSummary(authToken, org, externalId).catch(() => null) : null;
    return sentryIssueToTracker(issue, shortNames, ev);
  }
}
