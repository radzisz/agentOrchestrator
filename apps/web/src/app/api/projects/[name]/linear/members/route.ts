import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { linearApi as linear } from "@orchestrator/tracker-linear";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const resolved = resolveTrackerConfig(project.path, "linear");
  const apiKey = resolved?.apiKey;
  const teamKey = resolved?.teamKey;
  let teamId = resolved?.teamId;

  if (!apiKey || !teamKey) {
    return NextResponse.json({ error: "Linear not configured" }, { status: 400 });
  }

  if (!teamId) {
    const team = await linear.resolveTeam(apiKey, teamKey);
    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }
    teamId = team.id;
  }

  const members = await linear.getTeamMembers(apiKey, teamId);
  return NextResponse.json(members);
}
