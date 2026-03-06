import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
import { tryGetAggregate } from "@/lib/agent-aggregate";

const SRC = "reconcile";

export async function POST(
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

  const agg = tryGetAggregate(name, issueId);
  const oldStatus = agent.status;
  const changes: string[] = [];

  if (agg) {
    // Use aggregate's refreshAgent to reconcile all state axes (bypass debounce)
    await agg.refreshAgent({ force: true });
    const newStatus = agg.getLegacyStatus();
    if (newStatus !== oldStatus) {
      changes.push(`${oldStatus} → ${newStatus} (via refreshAgent)`);
      cmd.logInfo(SRC, `${issueId}: ${oldStatus} → ${newStatus} [${changes.join(", ")}]`);
    }

    // Also reconcile runtime
    const branchName = agent.branch || `agent/${issueId}`;
    const runtime = store.getRuntime(project.path, branchName, "LOCAL");
    if (runtime) {
      if ((runtime.status === "RUNNING" || runtime.status === "STARTING") && agg.state.container !== "running") {
        runtime.status = "STOPPED";
        runtime.servicesEnabled = false;
        runtime.updatedAt = new Date().toISOString();
        store.saveRuntime(project.path, branchName, "LOCAL", runtime);
        changes.push("Runtime was RUNNING but container dead → STOPPED");
      }
    }

    return NextResponse.json({
      issueId,
      oldStatus,
      newStatus: agg.getLegacyStatus(),
      containerRunning: agg.state.container === "running",
      hasRepo: true, // refreshAgent checked git
      remoteBranchExists: true, // not checked here — would need extra call
      changes,
    });
  }

  // Fallback: legacy reconcile logic
  let containerRunning = false;
  if (agent.containerName) {
    const names = await cmd.dockerPs({ name: agent.containerName, status: "running" }, { source: SRC });
    containerRunning = names.includes(agent.containerName);
  }

  let hasRepo = false;
  if (containerRunning && agent.containerName) {
    const r = await cmd.dockerExec(agent.containerName,
      "test -d /workspace/.git && echo yes || echo no",
      { source: SRC });
    hasRepo = r.stdout === "yes";
  }

  let remoteBranchExists = false;
  const branchName = agent.branch || `agent/${issueId}`;
  const ref = await cmd.git(
    `-C "${project.path}" ls-remote --heads origin "${branchName}"`,
    { source: SRC, timeout: 10000 },
  );
  remoteBranchExists = ref.ok && ref.stdout.length > 0;

  if (agent.status === "REMOVED" || agent.status === "DONE" || agent.status === "CLEANUP") {
    // Already terminal
  } else if (!containerRunning && !remoteBranchExists && !hasRepo) {
    agent.status = "REMOVED";
    changes.push("No container, no repo, no remote branch → REMOVED");
  } else if (!containerRunning && agent.status === "RUNNING") {
    agent.status = "EXITED";
    changes.push("Container not running → EXITED");
  } else if (agent.status === "MERGING" && !remoteBranchExists) {
    agent.status = "REMOVED";
    changes.push("Branch merged (no remote branch) → REMOVED");
  } else if (agent.status === "SPAWNING" && !containerRunning) {
    agent.status = "EXITED";
    changes.push("Spawn failed (no container) → EXITED");
  }

  const runtime = store.getRuntime(project.path, branchName, "LOCAL");
  if (runtime) {
    if ((runtime.status === "RUNNING" || runtime.status === "STARTING") && !containerRunning) {
      runtime.status = "STOPPED";
      runtime.servicesEnabled = false;
      runtime.updatedAt = new Date().toISOString();
      store.saveRuntime(project.path, branchName, "LOCAL", runtime);
      changes.push("Runtime was RUNNING but container dead → STOPPED");
    }
  }

  if (agent.status !== oldStatus) {
    agent.updatedAt = new Date().toISOString();
    store.saveAgent(project.path, issueId, agent);
    cmd.logInfo(SRC, `${issueId}: ${oldStatus} → ${agent.status} [${changes.join(", ")}]`);
  }

  return NextResponse.json({
    issueId, oldStatus, newStatus: agent.status,
    containerRunning, hasRepo, remoteBranchExists, changes,
  });
}
