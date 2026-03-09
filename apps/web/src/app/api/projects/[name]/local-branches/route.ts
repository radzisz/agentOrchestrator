import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
import * as gitSvc from "@/services/git";
import { findAggregate } from "@/lib/agent-aggregate";
import { reconcileAllRuntimes } from "@/services/runtime-reconcile";

const SRC = "local-branches";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!existsSync(project.path)) {
    return NextResponse.json(
      { error: `Project directory does not exist: ${project.path}` },
      { status: 400 }
    );
  }

  // Default branch
  const defaultBranch = await gitSvc.getDefaultBranch(project.path);

  const agents = store.listAgents(project.path);
  const runtimes = store.listRuntimes(project.path);
  const localRuntimeByBranch = new Map<string, store.RuntimeData>();
  for (const rt of runtimes) {
    if (rt.type === "LOCAL") localRuntimeByBranch.set(rt.branch, rt);
  }

  const runtimeConfig = store.getProjectJsonField(project.path, "RUNTIME_CONFIG");
  const runtimeModes = store.getProjectJsonField<{ local: boolean; remote: boolean }>(
    project.path, "RUNTIME_MODES"
  ) || { local: true, remote: false };

  const TERMINAL = new Set(["DONE", "REMOVED", "CANCELLED", "CLEANUP", "MERGED"]);

  // Batch container check
  const runningContainers = await cmd.getRunningContainers({ source: SRC });

  // Reconcile runtime statuses — if container is dead, clear stuck states
  reconcileAllRuntimes(project.path, runtimes, runningContainers);

  const enriched = await Promise.all(
    agents
      .map(async (agent) => {
        const dir = agent.agentDir || null;
        const branchName = agent.branch || `agent/${agent.issueId}`;

        const containerRunning = agent.containerName ? runningContainers.has(agent.containerName) : false;

        // Use aggregate state for git info (consistent, includes sticky merged)
        const agg = findAggregate(`${name}/${agent.issueId}`);
        const gitState = agg?.snapshot?.git;

        let commit = gitState?.lastCommit
          ? { sha: gitState.lastCommit.sha.slice(0, 7), message: gitState.lastCommit.message, author: gitState.lastCommit.author, date: gitState.lastCommit.date }
          : { sha: "", message: "", author: "", date: "" };
        let aheadBy = gitState?.aheadBy ?? 0;
        let behindBy = gitState?.behindBy ?? 0;
        const merged = gitState?.merged ?? false;

        // Fallback: if aggregate has no git info, try git directly
        if (dir && !gitState?.lastCommit && existsSync(`${dir}/.git`) && !TERMINAL.has(agent.status)) {
          const logR = await cmd.git(
            `-C "${dir}" log -1 --format="%H|%s|%an|%ci"`,
            { source: SRC, timeout: 5000 });
          if (logR.ok && logR.stdout) {
            const [sha, ...rest] = logR.stdout.split("|");
            const date = rest.pop() || "";
            const author = rest.pop() || "";
            const message = rest.join("|");
            commit = { sha: sha.slice(0, 7), message, author, date };
          }
          // Skip ahead/behind from shallow clone if aggregate already knows merged
          if (!merged) {
            const { ref: baseRef } = await gitSvc.getBaseRef(dir);
            const lr = await gitSvc.getLeftRight(dir, baseRef);
            aheadBy = lr.ahead;
            behindBy = lr.behind;
          }
        }

        // Aggregate merged state is authoritative — force 0/0
        if (merged) {
          aheadBy = 0;
          behindBy = 0;
        }

        const localRuntime = localRuntimeByBranch.get(branchName) || null;
        let runtimeInfo = null;
        if (localRuntime) {
          const safeBranch = branchName.replace(/[^a-zA-Z0-9_-]/g, "-");
          runtimeInfo = {
            id: `LOCAL/${safeBranch}`,
            type: "LOCAL" as const,
            status: localRuntime.status,
            branch: localRuntime.branch,
            servicesEnabled: localRuntime.servicesEnabled || false,
            containerName: localRuntime.containerName || null,
            previewUrl: localRuntime.previewUrl || null,
            supabaseUrl: localRuntime.supabaseUrl || null,
            expiresAt: localRuntime.expiresAt || null,
            error: localRuntime.error || null,
            netlifyDeployIds: localRuntime.netlifyDeployIds || null,
            servicePortMap: localRuntime.servicePortMap || null,
            portSlot: localRuntime.portSlot != null
              ? { id: `rt:${branchName}`, slot: localRuntime.portSlot }
              : null,
          };
        }

        return {
          name: branchName,
          issueId: agent.issueId,
          commit,
          aheadBy,
          behindBy,
          merged,
          agentId: agent.issueId,
          agentStatus: agent.status,
          agentUiStatus: (() => {
            const agg = findAggregate(`${name}/${agent.issueId}`);
            return agg ? agg.uiStatus : (agent.uiStatus ?? null);
          })(),
          agentTitle: agent.title,
          agentCreatedBy: agent.createdBy || null,
          agentCreatedAt: agent.createdAt || null,
          agentUpdatedAt: agent.updatedAt || null,
          agentDir: dir,
          containerRunning,
          localRuntime: runtimeInfo,
          runtimeConfig,
          runtimeModes,
        };
      })
  );

  return NextResponse.json(enriched);
}
