import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
import { findAggregate } from "@/lib/agent-aggregate";

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
  const headRef = await cmd.git(
    `-C "${project.path}" symbolic-ref refs/remotes/origin/HEAD`,
    { source: SRC, timeout: 5000 },
  );
  const defaultBranch = headRef.ok
    ? headRef.stdout.replace("refs/remotes/origin/", "")
    : "main";

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
  for (const rt of runtimes) {
    if (rt.type !== "LOCAL") continue;
    if (!rt.containerName || rt.mode === "host") continue;
    const alive = runningContainers.has(rt.containerName);
    if (!alive) {
      let dirty = false;
      if (rt.status === "RUNNING" || rt.status === "STARTING") {
        rt.status = "STOPPED";
        dirty = true;
      }
      if (rt.servicesEnabled) {
        rt.servicesEnabled = false;
        dirty = true;
      }
      if (dirty) {
        rt.updatedAt = new Date().toISOString();
        store.saveRuntime(project.path, rt.branch, rt.type, rt);
      }
    }
  }

  const enriched = await Promise.all(
    agents
      .filter((agent) => agent.agentDir)
      .map(async (agent) => {
        const dir = agent.agentDir!;
        const branchName = agent.branch || `agent/${agent.issueId}`;

        const containerRunning = agent.containerName ? runningContainers.has(agent.containerName) : false;

        // Use aggregate state for git info (consistent, includes sticky merged)
        const agg = findAggregate(`${name}/${agent.issueId}`);
        const gitState = agg?.state?.git;

        let commit = gitState?.lastCommit
          ? { sha: gitState.lastCommit.sha.slice(0, 7), message: gitState.lastCommit.message, author: gitState.lastCommit.author, date: gitState.lastCommit.date }
          : { sha: "", message: "", author: "", date: "" };
        let aheadBy = gitState?.aheadBy ?? 0;
        let behindBy = gitState?.behindBy ?? 0;
        const merged = gitState?.merged ?? false;

        // Fallback: if aggregate has no git info, try git directly
        if (!gitState?.lastCommit && existsSync(`${dir}/.git`) && !TERMINAL.has(agent.status)) {
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
            const countR = await cmd.git(
              `-C "${dir}" rev-list --left-right --count "origin/${defaultBranch}...HEAD"`,
              { source: SRC, timeout: 5000 });
            if (countR.ok && countR.stdout) {
              const [behind, ahead] = countR.stdout.split(/\s+/).map(Number);
              aheadBy = ahead || 0;
              behindBy = behind || 0;
            }
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
