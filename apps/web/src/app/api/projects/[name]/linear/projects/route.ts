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
  const teamId = resolved?.teamId;

  if (!apiKey) {
    return NextResponse.json({ error: "Linear not configured" }, { status: 400 });
  }

  const projects = await linear.listProjects(apiKey, teamId);
  return NextResponse.json(projects);
}
