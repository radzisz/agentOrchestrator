import { NextRequest, NextResponse } from "next/server";
import * as gitSvc from "@/services/git";
import { findAgentWithProject } from "@/lib/agent-aggregate/find-agent";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { files } = await req.json() as { files: string[] };

  if (!files?.length) {
    return NextResponse.json({ error: "No files specified" }, { status: 400 });
  }

  const found = findAgentWithProject(id);
  if (!found || !found.agent.agentDir) {
    return NextResponse.json({ error: "Agent or directory not found" }, { status: 404 });
  }

  const result = await gitSvc.revertFiles(found.agent.agentDir, files);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
