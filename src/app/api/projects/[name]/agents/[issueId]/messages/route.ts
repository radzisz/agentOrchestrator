import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { tryGetAggregate } from "@/lib/agent-aggregate";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string; issueId: string }> }
) {
  const { name, issueId } = await params;

  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const agent = store.getAgent(project.path, issueId);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const messages = store.getMessages(project.path, issueId);

  // Derive uiStatus live from aggregate (not from stale persisted value)
  const agg = tryGetAggregate(name, issueId);
  const uiStatus = agg ? agg.uiStatus : (agent.uiStatus || { status: "closed" });

  return NextResponse.json({ messages, status: agent.status, uiStatus });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string; issueId: string }> }
) {
  const { name, issueId } = await params;

  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const agent = store.getAgent(project.path, issueId);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const index = body.index;
  if (typeof index !== "number") {
    return NextResponse.json({ error: "index required" }, { status: 400 });
  }

  store.deleteMessage(project.path, issueId, index);

  // Sync .10timesdev/TASK.md with remaining messages
  if (agent.agentDir) {
    const remaining = store.getMessages(project.path, issueId);
    store.rewriteTaskMdInstructions(agent.agentDir, remaining);
  }

  return NextResponse.json({ success: true });
}
