import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { linearApi as linear } from "@orchestrator/tracker-linear";
import { triggerSync } from "@/services/dispatcher";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const resolved = resolveTrackerConfig(project.path, "linear");
  const linearApiKey = resolved?.apiKey;
  const linearTeamKey = resolved?.teamKey;
  const linearLabel = resolved?.label || "agent";

  if (!linearApiKey || !linearTeamKey) {
    return NextResponse.json(
      { error: "Linear not configured for this project (API Key + Team Key required)" },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { title, description } = body as { title: string; description?: string };

  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  try {
    // Resolve team UUID
    let linearTeamId = resolved?.teamId;
    if (!linearTeamId) {
      const team = await linear.resolveTeam(linearApiKey, linearTeamKey);
      if (!team) {
        return NextResponse.json(
          { error: `Could not resolve Linear team: ${linearTeamKey}` },
          { status: 400 }
        );
      }
      linearTeamId = team.id;
    }

    // Resolve label ID
    const labelId = await linear.getLabelId(linearApiKey, linearTeamId, linearLabel);
    const labelIds = labelId ? [labelId] : [];

    // Create issue
    const issue = await linear.createIssue(
      linearApiKey,
      linearTeamId,
      title.trim(),
      description?.trim() || "",
      labelIds
    );

    // Trigger dispatcher sync immediately so it picks up the new issue
    triggerSync().catch(() => {});

    return NextResponse.json({
      issueId: issue.identifier,
      issueUuid: issue.id,
      message: `Created ${issue.identifier} — the dispatcher will pick it up automatically.`,
    });
  } catch (err) {
    console.error("[request-change] Error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
