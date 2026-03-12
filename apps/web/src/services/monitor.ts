import { existsSync } from "fs";
import { eventBus } from "@/lib/event-bus";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
import * as gitSvc from "@/services/git";
import { tryGetAggregate, getAggregate } from "@/lib/agent-aggregate";

/**
 * Commit monitor — tracks agent commits and process state.
 */

const MONITOR_INTERVAL = 30000; // 30s
const SRC = "monitor";

let running = false;
let intervalId: NodeJS.Timeout | null = null;
let checking = false; // guard against overlapping checks
const lastSeen = new Map<string, string>();

export function start(): void {
  if (running) return;
  running = true;
  cmd.logInfo(SRC, "Starting commit monitor");

  check().catch(console.error);
  intervalId = setInterval(() => {
    if (checking) {
      cmd.logInfo(SRC, "Skipping check — previous still running");
      return;
    }
    check().catch(console.error);
  }, MONITOR_INTERVAL);
}

export function stop(): void {
  running = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function check(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    await doCheck();
  } finally {
    checking = false;
  }
}

async function doCheck(): Promise<void> {
  const projects = store.listProjects().filter((p) => !p.archived);

  // Batch: get all running containers once
  const runningContainers = await cmd.getRunningContainers({ source: SRC });

  for (const project of projects) {
    const agents = store.listAgents(project.path);

    // Reconcile stale currentOperation (server crash recovery) — cheap, no I/O
    reconcileStaleOperations(project, agents);

    // Skip heavy git operations on project repo if any agent has an active operation
    // (merge/rebase/spawn hold git locks on the project repo — concurrent git commands
    // would block on index.lock, starving the event loop and freezing the entire UI)
    const hasActiveOp = agents.some((a) => !!a.currentOperation);
    if (!hasActiveOp) {
      await Promise.all([
        detectExternalMerges(project, agents),
        autoRebaseStoppedAgents(project, agents),
      ]);
    }

    await Promise.all(agents.map(async (agent) => {
      if (agent.state?.lifecycle !== "active" && agent.state?.lifecycle !== "spawning") return;
      if (!agent.agentDir || !existsSync(`${agent.agentDir}/.git`)) return;
      // Skip agents with active operations — their git/container state is in flux
      if (agent.currentOperation) return;

      // Seed lastSeen from persisted state so we don't re-emit after server restart
      const commitKey = `${project.name}/${agent.issueId}`;
      if (!lastSeen.has(commitKey) && agent.state?.git?.lastCommit?.sha) {
        lastSeen.set(commitKey, agent.state.git.lastCommit.sha);
      }

      // Skip if aggregate already in terminal state (prevents re-processing loops)
      const existingAgg = tryGetAggregate(project.name, agent.issueId);
      if (existingAgg) {
        const ts = existingAgg.snapshot.trackerStatus;
        const lc = existingAgg.snapshot.lifecycle;
        if (ts === "done" || ts === "cancelled" || lc === "removed") return;
      }

      const branch = `agent/${agent.issueId}`;
      const key = `${project.name}/${agent.issueId}`;
      const containerAlive = agent.containerName ? runningContainers.has(agent.containerName) : false;

      try {
        // Check if Claude process is running (for RUNNING agents)
        if (agent.state?.agent === "running" && agent.containerName) {
          let claudeRunning = false;
          if (containerAlive) {
            const r = await cmd.dockerExec(agent.containerName,
              'pgrep -f "claude.*--dangerously-skip-permissions" 2>/dev/null',
              { source: SRC });
            claudeRunning = r.ok && r.stdout !== "";
          }

          if (!claudeRunning) {
            cmd.logInfo(SRC, `${agent.issueId}: ${containerAlive ? "claude stopped" : "container dead"} → EXITED`);
            const agg = tryGetAggregate(project.name, agent.issueId);
            if (agg) {
              agg.reportProcessExited();
              if (!containerAlive) agg.reportContainerDead();
            }
            store.appendLog(project.path, `agent-${agent.issueId}-lifecycle`, "claude process stopped, agent marked EXITED");
          }
        }

        // Check if branch still exists on remote
        const branchExists = await gitSvc.branchExistsOnRemote(agent.agentDir, branch);

        // null = network error → skip (don't assume branch is gone)
        if (branchExists === null) return;

        if (!branchExists) {
          let claudeRunning = false;
          if (containerAlive && agent.containerName) {
            const r = await cmd.dockerExec(agent.containerName,
              'pgrep -f "claude.*--dangerously-skip-permissions" 2>/dev/null',
              { source: SRC });
            claudeRunning = r.ok && r.stdout !== "";
          }
          if (!claudeRunning) {
            cmd.logInfo(SRC, `${agent.issueId}: branch ${branch} gone, claude not running → DONE`);
            const agg = tryGetAggregate(project.name, agent.issueId);
            if (agg) {
              agg.reportBranchGone();
            }
            store.appendLog(project.path, `agent-${agent.issueId}-lifecycle`, "branch removed from remote, agent marked DONE");
            eventBus.emit("agent:completed", { agentId: agent.issueId, issueId: agent.issueId });
          }
          return;
        }

        // Branch exists — fetch and check for new commits
        await gitSvc.fetchOrigin(agent.agentDir, branch, { timeout: 10_000 });

        const commit = await gitSvc.getLastCommit(agent.agentDir, `origin/${branch}`);
        if (!commit) return;

        if (lastSeen.get(key) !== commit.sha) {
          lastSeen.set(key, commit.sha);
          store.appendLog(project.path, `agent-${agent.issueId}-lifecycle`, `commit ${commit.sha} ${commit.message}`);
          eventBus.emit("agent:commit", {
            agentId: agent.issueId,
            issueId: agent.issueId,
            message: commit.message,
            hash: commit.sha,
          });
        }
      } catch {
        // Git fetch may fail for various reasons
      }
    }));

    // Check runtime processes
    const runtimes = store.listRuntimes(project.path);
    await Promise.all(runtimes.map(async (rt) => {
      if (rt.type !== "LOCAL" || rt.status !== "RUNNING" || !rt.containerName || rt.mode === "host") return;

      let servicesRunning = false;
      if (runningContainers.has(rt.containerName)) {
        const r = await cmd.dockerExec(rt.containerName,
          'pgrep -f "node|npm" 2>/dev/null',
          { source: SRC });
        servicesRunning = r.ok && r.stdout !== "";
      }

      if (!servicesRunning) {
        cmd.logInfo(SRC, `Runtime ${rt.branch}: services stopped → STOPPED`);
        const { reconcileDeadRuntime } = require("@/services/runtime-reconcile");
        reconcileDeadRuntime(project.path, rt);
      }
    }));
  }
}

// ---------------------------------------------------------------------------
// Auto-rebase stopped agents that are behind the default branch
// ---------------------------------------------------------------------------

async function autoRebaseStoppedAgents(
  project: store.ProjectWithConfig,
  agents: store.AgentData[],
): Promise<void> {
  const candidates = agents.filter((a) => {
    const s = a.state;
    return a.branch && a.agentDir &&
      s?.lifecycle === "active" &&
      s.agent === "stopped" &&
      !s.git?.merged &&
      (s.git?.op === "idle" || !s.git?.op) &&
      s.trackerStatus !== "done" && s.trackerStatus !== "cancelled" &&
      !a.currentOperation &&
      !a.rebaseResult?.conflict; // don't retry if last rebase had conflicts
  });
  if (candidates.length === 0) return;

  const defaultBranch = await gitSvc.getDefaultBranch(project.path);

  for (const agent of candidates) {
    try {
      const agentDir = agent.agentDir!;
      const branch = agent.branch!;

      if (!existsSync(`${agentDir}/.git`)) {
        cmd.logInfo(SRC, `auto-rebase:${agent.issueId}: skipping — no .git in ${agentDir}`);
        continue;
      }

      // Fetch latest default branch — deepen to ensure merge-base is reachable in shallow clones
      const fetched = await gitSvc.fetchOrigin(agentDir, defaultBranch, { deepen: 50, quiet: true, timeout: 15_000 });
      if (!fetched) {
        cmd.logInfo(SRC, `auto-rebase:${agent.issueId}: fetch failed`);
        continue;
      }

      // Check if agent branch is behind default branch
      const { ref: baseRef } = await gitSvc.getBaseRef(agentDir);
      const { behind } = await gitSvc.getAheadBehind(agentDir, branch);
      if (!behind || behind === 0) continue;

      cmd.logInfo(SRC, `${agent.issueId}: branch is ${behind} commit(s) behind ${defaultBranch} → auto-rebase`);
      store.appendLog(
        project.path,
        `agent-${agent.issueId}-lifecycle`,
        `auto-rebase: branch ${behind} commit(s) behind ${defaultBranch}`,
      );

      const agg = getAggregate(project.name, agent.issueId);
      await agg.rebase();
    } catch (e) {
      cmd.logError(`auto-rebase:${agent.issueId}`, `failed: ${e}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Detect branches merged outside orchestrator (e.g. via GitHub UI)
// ---------------------------------------------------------------------------

async function detectExternalMerges(
  project: store.ProjectWithConfig,
  agents: store.AgentData[],
): Promise<void> {
  const candidates = agents.filter((a) => {
    const ts = a.state?.trackerStatus;
    const lc = a.state?.lifecycle;
    return a.branch &&
      ts !== "done" && ts !== "cancelled" && lc !== "removed" &&
      lc === "active" &&
      !a.state?.git?.merged &&
      !a.currentOperation;
  });
  if (candidates.length === 0) return;

  const defaultBranch = await gitSvc.getDefaultBranch(project.path);

  // Fetch latest from remote once
  await gitSvc.fetchOrigin(project.path, defaultBranch, { quiet: true, timeout: 15_000 });

  for (const agent of candidates) {
    try {
      const merged = await gitSvc.isBranchMerged(project.path, agent.branch!);
      if (merged) {
        cmd.logInfo(SRC, `${agent.issueId}: branch ${agent.branch} merged into ${defaultBranch} externally → DONE`);

        const agg = tryGetAggregate(project.name, agent.issueId);
        if (agg) {
          agg.reportBranchMerged();
        }
        store.appendLog(
          project.path,
          `agent-${agent.issueId}-lifecycle`,
          `branch ${agent.branch} detected as merged into ${defaultBranch} — marked DONE`,
        );
        eventBus.emit("agent:completed", {
          agentId: agent.issueId,
          issueId: agent.issueId,
        });
      }
    } catch {
      // skip individual agent errors
    }
  }
}

// ---------------------------------------------------------------------------
// Clear stale currentOperation left by server crashes
// ---------------------------------------------------------------------------

const STALE_OP_MS = 5 * 60 * 1000; // 5 minutes

function reconcileStaleOperations(
  project: store.ProjectWithConfig,
  agents: store.AgentData[],
): void {
  for (const agent of agents) {
    // 1. Clear stale currentOperation (server crash during operation)
    if (agent.currentOperation?.startedAt) {
      const elapsed = Date.now() - new Date(agent.currentOperation.startedAt).getTime();
      if (elapsed > STALE_OP_MS) {
        const reason = `stale ${agent.currentOperation.name} after ${Math.round(elapsed / 1000)}s (server crash recovery)`;
        cmd.logInfo(SRC, `${agent.issueId}: ${reason} → clearing`);

        const agg = tryGetAggregate(project.name, agent.issueId);
        if (agg) {
          agg.clearStaleOperation(reason);
        } else {
          agent.currentOperation = null;
          if (agent.state?.git?.op && agent.state.git.op !== "idle") agent.state.git.op = "idle";
          if (agent.state?.transition) agent.state.transition = null;
          store.saveAgent(project.path, agent.issueId, agent);
          store.appendLog(project.path, `agent-${agent.issueId}-lifecycle`, `cleared stale operation: ${reason}`);
        }
      }
      continue;
    }

    // 2. Clear stuck git.op without currentOperation (crash mid-rebase/merge, operation was never recorded)
    if (agent.state?.git?.op && agent.state.git.op !== "idle" && !agent.currentOperation) {
      const reason = `stuck git.op="${agent.state.git.op}" with no currentOperation (crash recovery)`;
      cmd.logInfo(SRC, `${agent.issueId}: ${reason} → resetting to idle`);

      const agg = tryGetAggregate(project.name, agent.issueId);
      if (agg) {
        agg.clearStaleOperation(reason);
      } else {
        agent.state.git.op = "idle";
        if (agent.state.transition) agent.state.transition = null;
        store.saveAgent(project.path, agent.issueId, agent);
        store.appendLog(project.path, `agent-${agent.issueId}-lifecycle`, `cleared stuck state: ${reason}`);
      }
    }
  }
}
