import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { getContainerStatus, getContainerLogs, removeContainer } from "@/lib/docker";
import { tryGetAggregate } from "@/lib/agent-aggregate";
import * as containerOps from "@/lib/agent-aggregate/operations/container";

export async function POST(
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

  const body = await req.json();
  const action = body.action as string;

  if (action === "start") {
    try {
      const agg = tryGetAggregate(name, issueId);
      await containerOps.ensureContainerRunning(agent, project.path, agent.state!);
      if (agg) agg.reload();
      return NextResponse.json({ success: true, running: true });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === "stop") {
    if (!agent.containerName) {
      return NextResponse.json({ success: true, running: false });
    }
    try {
      await removeContainer(agent.containerName);
      return NextResponse.json({ success: true, running: false });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string; issueId: string }> }
) {
  const { name, issueId } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const agent = store.getAgent(project.path, issueId);
  if (!agent || !agent.containerName) {
    return NextResponse.json({ running: false, containerName: null });
  }

  const logsParam = req.nextUrl.searchParams.get("logs");
  if (logsParam !== null) {
    const tail = parseInt(req.nextUrl.searchParams.get("tail") || "150", 10);
    const logs = await getContainerLogs(agent.containerName, tail);
    return NextResponse.json({ logs });
  }

  try {
    const status = await getContainerStatus(agent.containerName);
    return NextResponse.json({
      running: status?.status === "running",
      containerName: agent.containerName,
      status: status?.status || "not found",
    });
  } catch {
    return NextResponse.json({ running: false, containerName: agent.containerName });
  }
}
