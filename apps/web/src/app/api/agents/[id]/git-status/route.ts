import { NextRequest, NextResponse } from "next/server";
import * as gitSvc from "@/services/git";
import { findAgentWithProject } from "@/lib/agent-aggregate/find-agent";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const found = findAgentWithProject(id);
  if (!found || !found.agent.agentDir) {
    return NextResponse.json({ hasUncommitted: false, containerMissing: true });
  }

  try {
    const status = await gitSvc.getStatus(found.agent.agentDir);
    return NextResponse.json({
      hasUncommitted: status.dirty,
      files: status.files.slice(0, 20),
    });
  } catch {
    return NextResponse.json({ hasUncommitted: false, error: "git unreachable" });
  }
}
