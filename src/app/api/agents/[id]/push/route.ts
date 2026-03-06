import { NextRequest, NextResponse } from "next/server";
import { simpleGit } from "@/lib/cmd";
import * as store from "@/lib/store";

function findAgent(id: string): { project: store.ProjectWithConfig; agent: store.AgentData; issueId: string } | null {
  const projects = store.listProjects();
  for (const project of projects) {
    const agent = store.getAgent(project.path, id);
    if (agent) return { project, agent, issueId: id };
  }
  return null;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const found = findAgent(id);
  if (!found) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const { project, agent, issueId } = found;
  if (!agent.agentDir || !agent.branch) {
    return NextResponse.json({ error: "No agent directory or branch" }, { status: 400 });
  }

  if (agent.branch === "main" || agent.branch === "master") {
    return NextResponse.json({ success: false, output: `Refusing to push: branch is ${agent.branch}` }, { status: 400 });
  }

  const git = simpleGit(agent.agentDir);

  try {
    await git.push("origin", `HEAD:refs/heads/${agent.branch}`, ["--force-with-lease"]);

    store.appendLog(project.path, `agent-${issueId}-lifecycle`, `push --force-with-lease to ${agent.branch}: success`);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[push:${issueId}]`, err);
    return NextResponse.json({ success: false, output: String(err) });
  }
}
