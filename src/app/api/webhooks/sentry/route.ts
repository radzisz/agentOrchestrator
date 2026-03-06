import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as linear from "@/services/linear";
import { appendLog } from "@/integrations/registry";

export async function POST(req: NextRequest) {
  const log = (msg: string) => appendLog("sentry", msg);

  try {
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
      const sentryProjects = store.getProjectJsonField<string[]>(p.path, "SENTRY_PROJECTS") || [];
      return sentryProjects.includes(sentryProject);
    });

    if (!matchedProject) {
      log(`No project mapped for Sentry project: ${sentryProject}`);
      return NextResponse.json({ ok: true, skipped: "no project mapping" });
    }

    log(`Mapped to project: ${matchedProject.name}`);
    const cfg = store.getProjectConfig(matchedProject.path);

    // Resolve Linear team ID
    let linearTeamId = cfg.LINEAR_TEAM_ID;
    if (!linearTeamId) {
      const team = await linear.resolveTeam(cfg.LINEAR_API_KEY, cfg.LINEAR_TEAM_KEY);
      if (team) {
        linearTeamId = team.id;
        cfg.LINEAR_TEAM_ID = linearTeamId;
        store.saveProjectConfig(matchedProject.path, cfg);
      } else {
        log(`Could not resolve Linear team ${cfg.LINEAR_TEAM_KEY}`);
        return NextResponse.json({ error: "team not found" }, { status: 500 });
      }
    }

    const labelId = await linear.getLabelId(
      cfg.LINEAR_API_KEY,
      linearTeamId,
      cfg.LINEAR_LABEL || "agent"
    );

    const sentryUrl = issue.shortId
      ? `https://sentry.io/issues/${issue.id}/`
      : issue.permalink || "";

    const title = `[Sentry] ${issue.title}`;
    const description = [
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
    ].filter(Boolean).join("\n");

    const linearIssue = await linear.createIssue(
      cfg.LINEAR_API_KEY,
      linearTeamId,
      title,
      description,
      labelId ? [labelId] : []
    );

    log(`Created Linear issue: ${linearIssue.identifier} — ${title}`);

    return NextResponse.json({
      ok: true,
      linearIssue: linearIssue.identifier,
      project: matchedProject.name,
    });
  } catch (error) {
    log(`Error processing webhook: ${String(error)}`);
    console.error("[sentry webhook]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
