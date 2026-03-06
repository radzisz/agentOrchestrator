import * as cmd from "@/lib/cmd";
import { eventBus } from "@/lib/event-bus";
import * as store from "@/lib/store";
import * as linear from "./linear";
import * as lifecycle from "./agent-lifecycle";
import * as runtime from "./runtime";
import { getPollInterval } from "@/integrations/linear";
import { tryGetAggregate, createAggregate } from "@/lib/agent-aggregate";
import { defaultAgentState } from "@/lib/agent-aggregate";

function log(message: string) {
  const msg = `[dispatcher] ${message}`;
  console.log(msg);
  const g = globalThis as any;
  const buffers: Map<string, Array<{ ts: string; message: string }>> | undefined = g.__integrationLogs;
  if (buffers) {
    let buf = buffers.get("linear");
    if (!buf) { buf = []; buffers.set("linear", buf); }
    buf.push({ ts: new Date().toISOString(), message: msg });
    if (buf.length > 200) buf.splice(0, buf.length - 200);
  }
}

/**
 * Dispatcher — main loop (replaces dispatcher.sh)
 */

let running = false;
let timeoutId: NodeJS.Timeout | null = null;

export function start(): void {
  if (running) return;
  running = true;
  log("Starting");
  scheduleNext(0);
}

export async function triggerSync(): Promise<void> {
  if (!running) return;
  log("Manual sync triggered");
  try {
    await tick();
  } catch (error) {
    log(`Triggered sync error: ${error}`);
  }
}

export function stop(): void {
  running = false;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  log("Stopped");
}

function scheduleNext(delayMs: number): void {
  timeoutId = setTimeout(async () => {
    if (!running) return;
    try {
      await tick();
    } catch (error) {
      log(`Tick error: ${error}`);
    }
    if (!running) return;
    const interval = await getPollInterval();
    log(`Next poll in ${interval / 1000}s`);
    scheduleNext(interval);
  }, delayMs);
}

async function tick(): Promise<void> {
  const projects = store.listProjects();

  for (const project of projects) {
    try {
      await processProject(project);
    } catch (error) {
      log(`Error processing ${project.name}: ${error}`);
    }
  }

  await cleanupExpiredRuntimes();
}

async function cleanupExpiredRuntimes(): Promise<void> {
  const projects = store.listProjects();
  for (const project of projects) {
    const runtimes = store.listRuntimes(project.path);
    for (const rt of runtimes) {
      if (
        rt.type === "REMOTE" &&
        rt.status === "RUNNING" &&
        rt.expiresAt &&
        new Date(rt.expiresAt) <= new Date()
      ) {
        try {
          log(`TTL expired for REMOTE runtime (branch: ${rt.branch})`);
          await runtime.cleanupRuntime(project.name, rt.branch, "REMOTE");
        } catch (error) {
          log(`Failed to cleanup expired runtime: ${error}`);
        }
      }
    }
  }
}

async function processProject(project: store.ProjectWithConfig): Promise<void> {
  const cfg = project.config;
  const linearApiKey = cfg.LINEAR_API_KEY;
  const linearTeamKey = cfg.LINEAR_TEAM_KEY;
  const linearLabel = cfg.LINEAR_LABEL || "agent";

  if (!linearApiKey || !linearTeamKey) return;

  // Resolve team ID if not cached
  let linearTeamId = cfg.LINEAR_TEAM_ID;
  if (!linearTeamId) {
    const team = await linear.resolveTeam(linearApiKey, linearTeamKey);
    if (!team) {
      log(`Could not resolve team ${linearTeamKey}`);
      return;
    }
    linearTeamId = team.id;
    // Cache it
    const envCfg = store.getProjectConfig(project.path);
    envCfg.LINEAR_TEAM_ID = linearTeamId;
    store.saveProjectConfig(project.path, envCfg);
  }

  const issues = await linear.getAgentIssues(linearApiKey, linearTeamId, linearLabel);
  log(`Poll ${project.name}: ${issues.length} issues (team=${linearTeamKey}, label=${linearLabel})`);

  // Log state distribution for debugging
  const stateCounts = new Map<string, number>();
  for (const issue of issues) {
    const s = issue.state.name;
    stateCounts.set(s, (stateCounts.get(s) || 0) + 1);
  }
  const stateStr = [...stateCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
  if (stateStr) log(`  States: ${stateStr}`);

  for (const issue of issues) {
    try {
      await processIssue(project, cfg, issue);
    } catch (error) {
      log(`Error on ${issue.identifier}: ${error}`);
    }
  }

  // Cleanup orphan agents
  await cleanupOrphans(project, issues.map((i) => i.identifier));
}

async function processIssue(
  project: store.ProjectWithConfig,
  cfg: store.ProjectConfig,
  issue: linear.LinearIssue
): Promise<void> {
  const state = issue.state.name;
  const issueId = issue.identifier;
  const linearApiKey = cfg.LINEAR_API_KEY;
  const linearTeamKey = cfg.LINEAR_TEAM_KEY;

  const agent = store.getAgent(project.path, issueId);

  // ---- TODO / BACKLOG → SPAWN ----
  if (["Todo", "Backlog", "Unstarted"].includes(state)) {
    if (!agent || !agent.spawned) {
      log(`SPAWN ${issueId}: "${issue.title}" (state=${state}, hasAgent=${!!agent}, spawned=${agent?.spawned})`);
      try {
        // Use aggregate for spawn
        const now = new Date().toISOString();
        const agentData: store.AgentData = agent || {
          issueId,
          title: issueId,
          status: "SPAWNING" as const,
          branch: `agent/${issueId}`,
          servicesEnabled: false,
          spawned: false,
          previewed: false,
          notified: false,
          createdAt: now,
          updatedAt: now,
          state: defaultAgentState(`agent/${issueId}`),
          currentOperation: null,
        };
        const agg = createAggregate(project.name, project.path, agentData);
        await agg.spawnAgent({ linearIssueUuid: issue.id });
        log(`SPAWN ${issueId}: ✓ success`);
      } catch (spawnErr) {
        log(`SPAWN ${issueId}: ✗ FAILED — ${spawnErr}`);
        return; // don't move to In Progress if spawn failed
      }

      const inProgressId = await linear.getWorkflowStateId(linearApiKey, linearTeamKey, "In Progress");
      if (inProgressId) {
        await linear.updateIssueState(linearApiKey, issue.id, inProgressId);
      }
    }
    return;
  }

  // ---- IN PROGRESS ----
  if (state === "In Progress") {
    let currentAgent = agent;

    if (!currentAgent) {
      log(`RE-SPAWN ${issueId}: In Progress but no agent record`);
      try {
        const now = new Date().toISOString();
        const agentData: store.AgentData = {
          issueId,
          title: issueId,
          status: "SPAWNING" as const,
          branch: `agent/${issueId}`,
          servicesEnabled: false,
          spawned: false,
          previewed: false,
          notified: false,
          createdAt: now,
          updatedAt: now,
          state: defaultAgentState(`agent/${issueId}`),
          currentOperation: null,
        };
        const agg = createAggregate(project.name, project.path, agentData);
        await agg.spawnAgent({ linearIssueUuid: issue.id });
        log(`RE-SPAWN ${issueId}: ✓ success`);
      } catch (spawnErr) {
        log(`RE-SPAWN ${issueId}: ✗ FAILED — ${spawnErr}`);
      }
      currentAgent = store.getAgent(project.path, issueId);
    }

    if (currentAgent) {
      await ensureClaudeRunning(currentAgent, project);
      await checkWakeTrigger(currentAgent, issue, project);

      // Check for "🤖 Gotowe" → trigger preview
      const agentDone = issue.comments.nodes.find((c) =>
        c.body.startsWith("🤖 Gotowe")
      );

      if (agentDone && !currentAgent.previewed) {
        log(`PREVIEW ${issueId}: agent completed`);

        const inReviewId = await linear.getWorkflowStateId(linearApiKey, linearTeamKey, "In Review");
        if (inReviewId) {
          await linear.updateIssueState(linearApiKey, issue.id, inReviewId);
        }

        currentAgent.previewed = true;
        currentAgent.status = "IN_REVIEW";
        store.saveAgent(project.path, issueId, currentAgent);

        eventBus.emit("agent:preview", {
          agentId: issueId,
          issueId,
        });
      }
    }
    return;
  }

  // ---- IN REVIEW ----
  if (state === "In Review") {
    if (!agent) return;

    const humanOk = issue.comments.nodes.find(
      (c) => !c.user.isMe && /^OK/i.test(c.body)
    );

    if (humanOk && !agent.notified) {
      log(`READY TO MERGE ${issueId}: ${issue.title}`);
      agent.notified = true;
      store.saveAgent(project.path, issueId, agent);

      store.appendLog(project.path, `agent-${issueId}-lifecycle`, `ready_to_merge approved_by=${humanOk.user.name}`);
    }
    return;
  }

  // ---- DONE / CANCELLED → CLEANUP ----
  if (["Done", "Canceled", "Cancelled"].includes(state)) {
    if (agent && !["DONE", "CANCELLED", "REMOVED", "CLEANUP"].includes(agent.status)) {
      log(`CLEANUP ${issueId}`);
      const agg = tryGetAggregate(project.name, issueId);
      if (agg) {
        await agg.removeAgent().catch((err) => log(`CLEANUP ${issueId} failed: ${err}`));
      } else {
        await lifecycle.cleanup(project.name, issueId);
      }
    }
    return;
  }

  // ---- Unhandled state ----
  log(`SKIP ${issueId}: unhandled state "${state}"`);
}

/**
 * Ensure Claude is running inside the agent's container.
 * Container is always alive (sleep infinity), so we check the Claude process.
 */
async function ensureClaudeRunning(
  agent: store.AgentData,
  project: store.ProjectWithConfig
): Promise<void> {
  if (!agent.containerName) return;

  // Check container status via CLI (not dockerode — avoids blocking on Windows named pipes)
  const inspectR = await cmd.run(
    `docker inspect --format "{{.State.Status}}" "${agent.containerName}"`,
    { source: "dispatcher", timeout: 10_000 },
  );
  const containerStatus = inspectR.ok ? inspectR.stdout.trim() : null;
  if (!containerStatus || containerStatus !== "running") {
    if (agent.status === "RUNNING") {
      log(`Container ${agent.containerName} dead, waking agent ${agent.issueId}`);
      try {
        await lifecycle.wake(project.name, agent.issueId);
      } catch (error) {
        log(`Failed to wake ${agent.issueId}: ${error}`);
      }
    }
    return;
  }

  // Container alive — check if Claude process is running via CLI
  if (agent.status === "RUNNING") {
    const r = await cmd.dockerExec(
      agent.containerName,
      'ps aux | grep -E "claude.*--dangerously-skip-permissions" | grep -v grep | grep -v " Z " || true',
      { source: "dispatcher", timeout: 10_000, user: "root" },
    );
    const claudeRunning = r.ok && r.stdout.trim().length > 0;

    if (!claudeRunning) {
      agent.status = "EXITED";
      agent.updatedAt = new Date().toISOString();
      store.saveAgent(project.path, agent.issueId, agent);
      log(`Claude not running in ${agent.containerName}, marked ${agent.issueId} as EXITED`);
    }
  }
}

async function checkWakeTrigger(
  agent: store.AgentData,
  issue: linear.LinearIssue,
  project: store.ProjectWithConfig
): Promise<void> {
  if (!agent.containerName) return;

  // Only wake if agent is EXITED (Claude finished) and container is alive
  if (agent.status !== "EXITED") return;

  const humanComments = issue.comments.nodes.filter((c) => !c.user.isMe);
  const botComments = issue.comments.nodes.filter((c) => c.user.isMe);

  const lastHuman = humanComments[humanComments.length - 1];
  const lastBot = botComments[botComments.length - 1];

  if (lastHuman && (!lastBot || lastHuman.createdAt > lastBot.createdAt)) {
    log(`WAKE ${agent.issueId}: new human comment`);
    const agg = tryGetAggregate(project.name, agent.issueId);
    if (agg) {
      await agg.wakeAgent(lastHuman.body);
    } else {
      await lifecycle.wake(project.name, agent.issueId, lastHuman.body);
    }
  }
}

async function cleanupOrphans(
  project: store.ProjectWithConfig,
  activeIssueIds: string[]
): Promise<void> {
  const agents = store.listAgents(project.path);

  for (const agent of agents) {
    if (!["DONE", "CANCELLED"].includes(agent.status) && !activeIssueIds.includes(agent.issueId)) {
      log(`ORPHAN CLEANUP ${agent.issueId}`);
      const agg = tryGetAggregate(project.name, agent.issueId);
      if (agg) {
        await agg.removeAgent().catch((err) => log(`ORPHAN CLEANUP ${agent.issueId} failed: ${err}`));
      } else {
        await lifecycle.cleanup(project.name, agent.issueId);
      }
    }
  }
}
