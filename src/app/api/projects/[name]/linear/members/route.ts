import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as linear from "@/services/linear";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const cfg = store.getProjectConfig(project.path);
  const apiKey = cfg.LINEAR_API_KEY;
  const teamKey = cfg.LINEAR_TEAM_KEY;

  if (!apiKey || !teamKey) {
    return NextResponse.json({ error: "Linear not configured" }, { status: 400 });
  }

  let teamId = cfg.LINEAR_TEAM_ID;
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
