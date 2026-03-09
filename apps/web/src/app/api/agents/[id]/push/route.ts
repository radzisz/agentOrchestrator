import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as gitSvc from "@/services/git";
import { findAgentWithProject } from "@/lib/agent-aggregate/find-agent";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const found = findAgentWithProject(id);
  if (!found) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const { project, agent, issueId } = found;
  if (!agent.agentDir || !agent.branch) {
    return NextResponse.json({ error: "No agent directory or branch" }, { status: 400 });
  }

  const result = await gitSvc.forcePushWithLease(agent.agentDir, agent.branch);
  if (!result.ok) {
    console.error(`[push:${issueId}]`, result.error);
    return NextResponse.json({ success: false, output: result.error });
  }

  store.appendLog(project.path, `agent-${issueId}-lifecycle`, `push --force-with-lease to ${agent.branch}: success`);
  return NextResponse.json({ success: true });
}
