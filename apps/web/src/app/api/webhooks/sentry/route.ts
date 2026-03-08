import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { appendLog } from "@/integrations/registry";
import { defaultAgentState, createAggregate } from "@/lib/agent-aggregate";
import type { TrackerIssue } from "@/lib/issue-trackers/types";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";
import { buildSentryIdentifier } from "@/lib/issue-trackers/sentry-tracker";

export async function POST(req: NextRequest) {
  const log = (msg: string) => appendLog("sentry", msg);

  try {
    // Check mode — if poll-only, skip webhook processing
    const sentryConfig = store.getIntegrationConfig("sentry");
    const mode = sentryConfig.config?.mode || "both";
    if (mode === "poll") {
      return NextResponse.json({ ok: true, skipped: "poll-only mode" });
    }

    const body = await req.json();
    const action = body.action;
    const sentryData = body.data;

    if (!sentryData?.issue) {
      return NextResponse.json({ ok: true, skipped: "no issue data" });
    }

    const issue = sentryData.issue;
    const sentryProject = issue.project?.slug || body.project_slug || body.project?.slug;

    if (!sentryProject) {
      log(`Webhook received but no project slug found`);
      return NextResponse.json({ ok: true, skipped: "no project slug" });
    }

    if (action !== "created" && action !== "regression") {
      log(`Skipping action: ${action} for ${sentryProject}`);
      return NextResponse.json({ ok: true, skipped: `action=${action}` });
    }

    log(`Sentry alert: [${action}] ${sentryProject} — ${issue.title}`);

    // Find which orchestrator project owns this Sentry project
    const projects = store.listProjects();
    const matchedProject = projects.find((p) => {
      const resolved = resolveTrackerConfig(p.path, "sentry");
      const sentryProjects = resolved?.projects?.split(",").map((s: string) => s.trim()).filter(Boolean) || [];
      return sentryProjects.includes(sentryProject);
    });

    if (!matchedProject) {
      log(`No project mapped for Sentry project: ${sentryProject}`);
      return NextResponse.json({ ok: true, skipped: "no project mapping" });
    }

    log(`Mapped to project: ${matchedProject.name}`);

    // Build identifier and check for existing agent (dedup)
    const resolved = resolveTrackerConfig(matchedProject.path, "sentry");
    const identifier = buildSentryIdentifier(issue.shortId, sentryProject, resolved?.projectShortNames);

    const existingAgent = store.getAgent(matchedProject.path, identifier);
    if (existingAgent?.spawned) {
      log(`Skipping ${identifier}: agent already exists`);
      return NextResponse.json({ ok: true, skipped: "agent exists", agentId: identifier });
    }

    // Build TrackerIssue from webhook payload
    const sentryUrl = issue.shortId
      ? `https://sentry.io/issues/${issue.id}/`
      : issue.permalink || "";

    const trackerIssue: TrackerIssue = {
      externalId: issue.id as string,
      identifier,
      title: `[Sentry] ${issue.title}`,
      description: [
        `**Sentry ${action === "regression" ? "Regression" : "New Issue"}**`,
        "",
        `**Project:** ${sentryProject}`,
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
        issue.metadata?.value || issue.message || "",
      ].filter(Boolean).join("\n"),
      priority: issue.level === "fatal" ? 1 : issue.level === "error" ? 2 : 3,
      phase: "todo",
      rawState: issue.status || "unresolved",
      labels: [],
      createdBy: null,
      url: sentryUrl,
      source: "sentry",
      comments: [],
      _raw: issue,
    };

    // Spawn agent
    const now = new Date().toISOString();
    const agentData: store.AgentData = existingAgent || {
      issueId: identifier,
      title: trackerIssue.title,
      status: "SPAWNING" as const,
      branch: `agent/${identifier}`,
      servicesEnabled: false,
      spawned: false,
      previewed: false,
      notified: false,
      createdAt: now,
      updatedAt: now,
      state: defaultAgentState(`agent/${identifier}`),
      currentOperation: null,
    };

    const agg = createAggregate(matchedProject.name, matchedProject.path, agentData);
    await agg.spawnAgent({ trackerIssue });

    log(`Spawned agent ${identifier} for Sentry issue ${issue.shortId}`);

    return NextResponse.json({
      ok: true,
      agentId: identifier,
      project: matchedProject.name,
    });
  } catch (error) {
    log(`Error processing webhook: ${String(error)}`);
    console.error("[sentry webhook]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
