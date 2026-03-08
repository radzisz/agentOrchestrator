import { existsSync } from "fs";
import { eventBus } from "@/lib/event-bus";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
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
  const projects = store.listProjects();

  // Batch: get all running containers once
  const runningContainers = await cmd.getRunningContainers({ source: SRC });

  for (const project of projects) {
    const agents = store.listAgents(project.path);

    // Detect externally merged branches for active agents
    await detectExternalMerges(project, agents);

    // Auto-rebase stopped agents that are behind default branch
    await autoRebaseStoppedAgents(project, agents);

    // Reconcile stale currentOperation (server crash recovery)
    reconcileStaleOperations(project, agents);

    await Promise.all(agents.map(async (agent) => {
      if (agent.state?.lifecycle !== "active" && agent.state?.lifecycle !== "spawning") return;
      if (!agent.agentDir || !existsSync(`${agent.agentDir}/.git`)) return;

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

        // Check if branch still exists on remote — always use local git (host filesystem)
        const lsRemote = await cmd.git(`-C "${agent.agentDir}" ls-remote --heads origin "${branch}"`, { source: SRC, timeout: 10000 });

        // Distinguish between "branch doesn't exist" (ok + empty stdout)
        // and "ls-remote failed" (network/auth error). Only treat empty output
        // from a successful command as branch-gone.
        if (lsRemote.ok && !lsRemote.stdout.trim()) {
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
        // ls-remote failed (auth/network error) — skip, don't assume branch is gone
        if (!lsRemote.ok) return;

        const fetchR = await cmd.git(`-C "${agent.agentDir}" fetch origin "${branch}"`, { source: SRC, timeout: 10000 });

        const logR = await cmd.git(`-C "${agent.agentDir}" log -1 --format="%H %s" "origin/${branch}"`, { source: SRC });

        if (!logR.ok || !logR.stdout) return;

        const [hash, ...msgParts] = logR.stdout.split(" ");
        const message = msgParts.join(" ");

        if (lastSeen.get(key) !== hash) {
          lastSeen.set(key, hash);
          store.appendLog(project.path, `agent-${agent.issueId}-lifecycle`, `commit ${hash} ${message}`);
          eventBus.emit("agent:commit", {
            agentId: agent.issueId,
            issueId: agent.issueId,
            message,
            hash,
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
        rt.status = "STOPPED";
        rt.servicesEnabled = false;
        rt.updatedAt = new Date().toISOString();
        store.saveRuntime(project.path, rt.branch, rt.type, rt);
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
  // Only rebase agents that are: active, stopped (not running), not merged,
  // no current operation, and not already in a git op
  const candidates = agents.filter((a) => {
    const s = a.state;
    return a.branch && a.agentDir &&
      s?.lifecycle === "active" &&
      s.agent === "stopped" &&
      !s.git?.merged &&
      (s.git?.op === "idle" || !s.git?.op) &&
      s.trackerStatus !== "done" && s.trackerStatus !== "cancelled" &&
      !a.currentOperation;
  });
  if (candidates.length === 0) return;

  // Get default branch name
  const defaultBranch = await detectDefaultBranch(project.path);

  for (const agent of candidates) {
    try {
      const agentDir = agent.agentDir!;
      const branch = agent.branch!;

      // Verify .git exists on host
      if (!existsSync(`${agentDir}/.git`)) {
        cmd.logInfo(SRC, `auto-rebase:${agent.issueId}: skipping — no .git in ${agentDir}`);
        continue;
      }

      // Fetch latest default branch — deepen to ensure merge-base is reachable in shallow clones
      const fetchR = await cmd.git(`-C "${agentDir}" fetch origin "${defaultBranch}" --quiet --deepen=50`, {
        source: SRC, timeout: 15000,
      });
      if (!fetchR.ok) {
        cmd.logInfo(SRC, `auto-rebase:${agent.issueId}: fetch failed — ${fetchR.stderr}`);
        continue;
      }

      // Check if agent branch is behind default branch
      const behindR = await cmd.git(
        `-C "${agentDir}" rev-list --count "${branch}..origin/${defaultBranch}"`,
        { source: SRC, timeout: 5000 },
      );
      if (!behindR.ok) {
        cmd.logInfo(SRC, `auto-rebase:${agent.issueId}: rev-list failed — ${behindR.stderr}`);
        continue;
      }

      const behind = parseInt(behindR.stdout.trim(), 10);
      if (!behind || behind === 0) continue;

      cmd.logInfo(SRC, `${agent.issueId}: branch is ${behind} commit(s) behind ${defaultBranch} → auto-rebase`);
      store.appendLog(
        project.path,
        `agent-${agent.issueId}-lifecycle`,
        `auto-rebase: branch ${behind} commit(s) behind ${defaultBranch}`,
      );

      // Trigger rebase — this handles conflicts automatically (wakes agent if needed)
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

/** Detect default branch from origin/HEAD, fallback to main then master. */
async function detectDefaultBranch(projectPath: string): Promise<string> {
  const refR = await cmd.git(
    `-C "${projectPath}" symbolic-ref refs/remotes/origin/HEAD`,
    { source: SRC, timeout: 5000 },
  );
  if (refR.ok && refR.stdout) {
    return refR.stdout.replace("refs/remotes/origin/", "");
  }
  // Fallback: check if origin/main exists
  const mainR = await cmd.git(
    `-C "${projectPath}" rev-parse --verify origin/main`,
    { source: SRC, timeout: 5000 },
  );
  if (mainR.ok) return "main";
  return "master";
}

const STALE_OP_MS = 5 * 60 * 1000; // 5 minutes

async function detectExternalMerges(
  project: store.ProjectWithConfig,
  agents: store.AgentData[],
): Promise<void> {
  // Only check active agents that are not already merged/done
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

  // Fetch default branch name
  const defaultBranch = await detectDefaultBranch(project.path);

  // Fetch latest from remote once
  await cmd.git(`-C "${project.path}" fetch origin "${defaultBranch}" --quiet`, {
    source: SRC,
    timeout: 15000,
  });

  for (const agent of candidates) {
    try {
      // Check if agent branch is fully merged into origin/defaultBranch
      // git branch -r --merged origin/main | grep agent/ISSUE
      const mergedR = await cmd.git(
        `-C "${project.path}" branch -r --merged "origin/${defaultBranch}"`,
        { source: SRC, timeout: 10000 },
      );
      if (!mergedR.ok) continue;

      const isMerged = mergedR.stdout
        .split("\n")
        .some((l) => l.trim() === `origin/${agent.branch}`);

      if (isMerged) {
        cmd.logInfo(SRC, `${agent.issueId}: branch ${agent.branch} merged into ${defaultBranch} externally → DONE`);

        // Update aggregate so the guard prevents re-processing
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

function reconcileStaleOperations(
  project: store.ProjectWithConfig,
  agents: store.AgentData[],
): void {
  for (const agent of agents) {
    if (!agent.currentOperation?.startedAt) continue;
    const elapsed = Date.now() - new Date(agent.currentOperation.startedAt).getTime();
    if (elapsed <= STALE_OP_MS) continue;

    cmd.logInfo(SRC, `${agent.issueId}: stale currentOperation "${agent.currentOperation.name}" (${Math.round(elapsed / 1000)}s) → clearing`);
    agent.currentOperation = null;
    store.saveAgent(project.path, agent.issueId, agent);
    store.appendLog(
      project.path,
      `agent-${agent.issueId}-lifecycle`,
      `cleared stale currentOperation after ${Math.round(elapsed / 1000)}s (server crash recovery)`,
    );
  }
}
