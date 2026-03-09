import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as gitSvc from "@/services/git";
import { findAgentInfo } from "@/lib/agent-aggregate/find-agent";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const info = findAgentInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const project = store.getProjectByName(info.projectName);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const defaultBranch = await gitSvc.getDefaultBranch(project.path);

  const agentBranchName = `agent/${info.issueId}`;
  const exists = await gitSvc.branchExistsOnRemote(project.path, agentBranchName);
  const agentBranch = exists ? agentBranchName : null;

  return NextResponse.json({ agentBranch, defaultBranch });
}
