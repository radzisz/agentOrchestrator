import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { tryGetAggregate } from "@/lib/agent-aggregate";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string; issueId: string }> }
) {
  const { name, issueId } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const agent = store.getAgent(project.path, issueId);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const runtimes = store.listRuntimes(project.path);
  const rt = runtimes.find((r) => r.branch === agent.branch && r.type === "LOCAL") || null;

  return NextResponse.json({
    servicesEnabled: agent.servicesEnabled ?? false,
    runtimeStatus: rt?.status || "STOPPED",
    mode: rt?.mode || "container",
    error: rt?.error || null,
    servicePortMap: rt?.servicePortMap || null,
    portSlot: rt?.portSlot ?? null,
    containerName: rt?.containerName || agent.containerName || null,
    agentDir: agent.agentDir || null,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string; issueId: string }> }
) {
  const { name, issueId } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const agent = store.getAgent(project.path, issueId);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const enable = body.enabled as boolean;
  const mode = (body.mode as "container" | "host") || "container";

  const agg = tryGetAggregate(name, issueId);

  if (enable) {
    if (agg) {
      agg.startServices({ mode }).catch((err) => {
        console.error(`[services] startServices failed for ${issueId}:`, err);
      });
    } else {
      // Fallback: direct runtime call
      const runtime = await import("@/services/runtime");
      const branch = agent.branch || `agent/${issueId}`;
      agent.servicesEnabled = true;
      store.saveAgent(project.path, issueId, agent);
      if (mode === "host") {
        runtime.startLocalHost(name, branch).catch((err) => {
          console.error(`[services] startLocalHost failed for ${issueId}:`, err);
        });
      } else {
        runtime.startLocal(name, branch).catch((err) => {
          console.error(`[services] startLocal failed for ${issueId}:`, err);
        });
      }
    }
    return NextResponse.json({ ok: true, action: "starting" });
  } else {
    // Stop bypasses the aggregate lock — it must be immediate and forceful,
    // even if startServices is still running and holding the lock.
    const runtime = await import("@/services/runtime");
    const branch = agent.branch || `agent/${issueId}`;
    agent.servicesEnabled = false;
    store.saveAgent(project.path, issueId, agent);
    try {
      await runtime.stopRuntime(name, branch, "LOCAL");
      return NextResponse.json({ ok: true, action: "stopped" });
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }
}
