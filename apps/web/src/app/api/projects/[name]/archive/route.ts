import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { removeContainer } from "@/lib/docker";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = await req.json();
  const archived = body.archived === true;

  // When archiving — stop all running containers for this project's agents
  if (archived) {
    const agents = store.listAgents(project.path);
    for (const agent of agents) {
      if (agent.containerName) {
        try {
          await removeContainer(agent.containerName);
        } catch {
          // best effort — container may already be stopped
        }
      }
    }
  }

  store.setProjectArchived(name, archived);

  return NextResponse.json({ ok: true, archived });
}
