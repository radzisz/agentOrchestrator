import { existsSync } from "fs";
import { eventBus } from "@/lib/event-bus";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
import { tryGetAggregate } from "@/lib/agent-aggregate";

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

    // Reconcile stale currentOperation (server crash recovery)
    reconcileStaleOperations(project, agents);

    await Promise.all(agents.map(async (agent) => {
      if (!["RUNNING", "EXITED"].includes(agent.status)) return;
      if (!agent.agentDir || !existsSync(`${agent.agentDir}/.git`)) return;

      // Skip if aggregate already in terminal state (prevents re-processing loops)
      const existingAgg = tryGetAggregate(project.name, agent.issueId);
      if (existingAgg) {
        const ls = existingAgg.state.linearStatus;
        const lc = existingAgg.state.lifecycle;
        if (ls === "done" || ls === "cancelled" || lc === "removed") return;
      }

      const branch = `agent/${agent.issueId}`;
      const key = `${project.name}/${agent.issueId}`;
      const containerAlive = agent.containerName ? runningContainers.has(agent.containerName) : false;

      try {
        // Check if Claude process is running (for RUNNING agents)
        if (agent.status === "RUNNING" && agent.containerName) {
          let claudeRunning = false;
          if (containerAlive) {
            const r = await cmd.dockerExec(agent.containerName,
              'pgrep -f "claude.*--dangerously-skip-permissions" 2>/dev/null',
              { source: SRC });
            claudeRunning = r.ok && r.stdout !== "";
          }

          if (!claudeRunning) {
            cmd.logInfo(SRC, `${agent.issueId}: ${containerAlive ? "claude stopped" : "container dead"} → EXITED`);
            // Update via aggregate so state axes stay consistent
            const agg = tryGetAggregate(project.name, agent.issueId);
            if (agg) {
              agg.state.agent = "stopped";
              if (!containerAlive) agg.state.container = "missing";
            }
            agent.status = "EXITED";
            agent.updatedAt = new Date().toISOString();
            store.saveAgent(project.path, agent.issueId, agent);
            store.appendLog(project.path, `agent-${agent.issueId}-lifecycle`, "claude process stopped, agent marked EXITED");
            eventBus.emit("agent:exited", { agentId: agent.issueId, issueId: agent.issueId });
          }
        }

        // Check if branch still exists on remote
        const useContainer = agent.containerName && containerAlive;
        const lsRemote = useContainer
          ? await cmd.dockerGit(agent.containerName!, `ls-remote --heads origin "${branch}"`, { source: SRC, timeout: 10000 })
          : await cmd.git(`-C "${agent.agentDir}" ls-remote --heads origin "${branch}"`, { source: SRC, timeout: 10000 });

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
            // Double-check from the project repo (different auth context)
            const projectCheck = await cmd.git(
              `-C "${project.path}" ls-remote --heads origin "${branch}"`,
              { source: SRC, timeout: 10000 },
            );
            if (projectCheck.ok && projectCheck.stdout.trim()) {
              // Branch exists on remote — ls-remote in container was wrong
              return;
            }

            cmd.logInfo(SRC, `${agent.issueId}: branch ${branch} gone, claude not running → DONE`);
            // Update via aggregate so state axes stay consistent
            const agg = tryGetAggregate(project.name, agent.issueId);
            if (agg) {
              agg.state.linearStatus = "done";
              agg.state.agent = "stopped";
            }
            agent.status = "DONE";
            agent.updatedAt = new Date().toISOString();
            store.saveAgent(project.path, agent.issueId, agent);
            store.appendLog(project.path, `agent-${agent.issueId}-lifecycle`, "branch removed from remote, agent marked DONE");
            eventBus.emit("agent:completed", { agentId: agent.issueId, issueId: agent.issueId });
          }
          return;
        }
        // ls-remote failed (auth/network error) — skip, don't assume branch is gone
        if (!lsRemote.ok) return;

        const fetchR = useContainer
          ? await cmd.dockerGit(agent.containerName!, `fetch origin "${branch}"`, { source: SRC, timeout: 10000 })
          : await cmd.git(`-C "${agent.agentDir}" fetch origin "${branch}"`, { source: SRC, timeout: 10000 });

        const logR = useContainer
          ? await cmd.dockerGit(agent.containerName!, `log -1 --format="%H %s" "origin/${branch}"`, { source: SRC })
          : await cmd.git(`-C "${agent.agentDir}" log -1 --format="%H %s" "origin/${branch}"`, { source: SRC });

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
// Detect branches merged outside orchestrator (e.g. via GitHub UI)
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["DONE", "REMOVED", "CANCELLED", "CLEANUP", "MERGED"]);
const STALE_OP_MS = 5 * 60 * 1000; // 5 minutes

async function detectExternalMerges(
  project: store.ProjectWithConfig,
  agents: store.AgentData[],
): Promise<void> {
  // Only check active agents that are not already merged/done
  const candidates = agents.filter((a) =>
    a.branch &&
    !TERMINAL_STATUSES.has(a.status) &&
    a.state?.lifecycle === "active" &&
    !a.state?.git?.merged &&
    !a.currentOperation
  );
  if (candidates.length === 0) return;

  // Fetch default branch name
  const refR = await cmd.git(
    `-C "${project.path}" symbolic-ref refs/remotes/origin/HEAD`,
    { source: SRC, timeout: 5000 },
  );
  let defaultBranch = "main";
  if (refR.ok && refR.stdout) {
    defaultBranch = refR.stdout.replace("refs/remotes/origin/", "");
  }

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

        if (agent.state) {
          agent.state.linearStatus = "done";
          agent.state.git.merged = true;
        }
        agent.status = "DONE";
        store.saveAgent(project.path, agent.issueId, agent);
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
