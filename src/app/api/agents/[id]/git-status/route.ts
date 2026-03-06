import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";

const SRC = "git-status";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const projects = store.listProjects();
  let agent: store.AgentData | null = null;
  for (const project of projects) {
    agent = store.getAgent(project.path, id);
    if (agent) break;
  }

  if (!agent || !agent.agentDir) {
    return NextResponse.json({ hasUncommitted: false, containerMissing: true });
  }

  try {
    const r = await cmd.git(`-C "${agent.agentDir}" status --porcelain`, { source: SRC });
    const lines = r.stdout.trim();
    return NextResponse.json({
      hasUncommitted: lines.length > 0,
      files: lines ? lines.split("\n").slice(0, 20) : [],
    });
  } catch {
    return NextResponse.json({ hasUncommitted: false, error: "git unreachable" });
  }
}
