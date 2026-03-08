import { NextRequest, NextResponse } from "next/server";
import { findAggregate } from "@/lib/agent-aggregate";
import * as store from "@/lib/store";
import { getContainerLogs } from "@/lib/docker";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  const tail = parseInt(req.nextUrl.searchParams.get("tail") || "200");
  const file = req.nextUrl.searchParams.get("file"); // specific log file

  // Resolve runtime mode for this agent
  const branch = agg.agentData.branch;
  const rt = branch ? store.getRuntime(agg.projectPath, branch, "LOCAL") : null;
  const runtimeMode = rt?.mode || "container";

  const safeBranch = (branch || `agent/${agg.issueId}`).replace(/[^a-zA-Z0-9_-]/g, "-");
  const runtimePrefix = `runtime-${safeBranch}`;

  // If specific file requested, return just that
  if (file) {
    if (file === "container") {
      const containerName = agg.agentData.containerName;
      const logs = containerName ? await getContainerLogs(containerName, tail) : "";
      return NextResponse.json({ logs });
    }
    // runtime:* files — e.g. "runtime:guide", "runtime:admin", or "runtime" (general)
    if (file.startsWith("runtime")) {
      const suffix = file === "runtime" ? "" : `-${file.split(":")[1]}`;
      const logs = store.readLog(agg.projectPath, `${runtimePrefix}${suffix}`, tail);
      return NextResponse.json({ logs });
    }
    const logs = store.readLog(agg.projectPath, `agent-${agg.issueId}-${file}`, tail);
    return NextResponse.json({ logs });
  }

  // List available log files
  const logFiles = store.listAgentLogs(agg.projectPath, agg.issueId);

  const files = logFiles.map(f => ({
    name: f.name,
    updatedAt: new Date(f.mtime).toISOString(),
  }));

  // Add runtime log entries (per-service + general)
  const runtimeLogs = store.listRuntimeLogs(agg.projectPath, safeBranch);
  for (const rl of runtimeLogs) {
    // rl.name is e.g. "runtime-agent-UKR-118" or "runtime-agent-UKR-118-guide"
    const suffix = rl.name.slice(runtimePrefix.length); // "" or "-guide"
    const displayName = suffix ? `runtime:${suffix.slice(1)}` : "runtime";
    files.unshift({
      name: displayName,
      updatedAt: new Date(rl.mtime).toISOString(),
    });
  }

  // Container mode — show container logs if container exists and no host runtime
  if (runtimeMode !== "host") {
    const containerName = agg.agentData.containerName;
    if (containerName) {
      files.unshift({ name: "container", updatedAt: new Date().toISOString() });
    }
  }

  return NextResponse.json({ files });
}
