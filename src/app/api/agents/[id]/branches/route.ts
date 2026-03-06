import { NextRequest, NextResponse } from "next/server";
import { simpleGit } from "@/lib/cmd";
import * as store from "@/lib/store";
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

  const git = simpleGit(project.path);

  // Detect default branch
  let defaultBranch = "main";
  try {
    const ref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    defaultBranch = ref.trim().replace("refs/remotes/origin/", "");
  } catch {
    try {
      await git.raw(["rev-parse", "--verify", "origin/main"]);
    } catch {
      defaultBranch = "master";
    }
  }

  // Check if agent branch exists on remote
  const agentBranchName = `agent/${info.issueId}`;
  let agentBranch: string | null = null;
  try {
    const lsRemote = await git.raw(["ls-remote", "--heads", "origin", agentBranchName]);
    if (lsRemote.trim()) {
      agentBranch = agentBranchName;
    }
  } catch {
    // branch doesn't exist on remote
  }

  return NextResponse.json({ agentBranch, defaultBranch });
}
