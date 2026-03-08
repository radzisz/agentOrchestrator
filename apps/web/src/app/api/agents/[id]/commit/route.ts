import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";

const SRC = "commit";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { message } = await req.json() as { message: string };

  if (!message?.trim()) {
    return NextResponse.json({ error: "Commit message required" }, { status: 400 });
  }

  const projects = store.listProjects();
  let agent: store.AgentData | null = null;
  let projectPath = "";
  for (const project of projects) {
    agent = store.getAgent(project.path, id);
    if (agent) { projectPath = project.path; break; }
  }

  if (!agent || !agent.agentDir) {
    return NextResponse.json({ error: "Agent or directory not found" }, { status: 404 });
  }

  const dir = agent.agentDir;

  try {
    const safeMsg = message.trim().replace(/'/g, "'\\''");
    await cmd.git(`-C "${dir}" config user.email "agent@10timesdev.com"`, { source: SRC });
    await cmd.git(`-C "${dir}" config user.name "10timesdev"`, { source: SRC });
    await cmd.git(`-C "${dir}" add -A`, { source: SRC });
    const commitR = await cmd.git(`-C "${dir}" commit -m '${safeMsg}'`, { source: SRC });
    if (!commitR.ok) {
      return NextResponse.json({ error: commitR.stderr || "Commit failed" }, { status: 500 });
    }
    const pushR = await cmd.git(`-C "${dir}" push origin HEAD`, { source: SRC, timeout: 30000 });
    if (!pushR.ok) {
      return NextResponse.json({ error: pushR.stderr || "Push failed" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
