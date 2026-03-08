import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { sentryApi as sentry } from "@orchestrator/tracker-sentry";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";

function getConfig(name: string) {
  const project = store.getProjectByName(name);
  if (!project) return null;
  const resolved = resolveTrackerConfig(project.path, "sentry");
  if (!resolved?.authToken || !resolved?.org) return null;
  return { authToken: resolved.authToken, org: resolved.org };
}

/** GET — list available Sentry projects in the org. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const cfg = getConfig(name);
  if (!cfg) return NextResponse.json({ error: "Sentry not configured" }, { status: 400 });

  const projects = await sentry.listProjects(cfg.authToken, cfg.org);
  return NextResponse.json(projects);
}
