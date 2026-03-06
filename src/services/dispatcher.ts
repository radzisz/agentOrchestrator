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
  const linearLabel = cfg.LINEAR_LABEL;
  const linearAssigneeId = cfg.LINEAR_ASSIGNEE_ID;

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

  let issues: linear.LinearIssue[];
  if (linearAssigneeId) {
    issues = await linear.getAssignedIssues(linearApiKey, linearTeamId, linearAssigneeId);
    log(`Poll ${project.name}: ${issues.length} issues (assignee=${cfg.LINEAR_ASSIGNEE_NAME || linearAssigneeId})`);
  } else {
    const label = linearLabel || "agent";
    issues = await linear.getAgentIssues(linearApiKey, linearTeamId, label);
    log(`Poll ${project.name}: ${issues.length} issues (label=${label})`);
  }

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
      await checkPreviewLabel(currentAgent, issue, project, cfg);

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

        // Auto-restart remote preview if preview label is on the issue
        if (hasPreviewLabel(issue, cfg) && currentAgent.branch) {
          fireRemotePreview(currentAgent, issue, project, cfg, true);
        }

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

    await checkPreviewLabel(agent, issue, project, cfg);

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
 * Check if the preview label is present on the issue.
 * If yes and no active runtime → start remote preview (handles "label just appeared").
 * The label is NEVER removed — it's a persistent flag.
 */
async function checkPreviewLabel(
  agent: store.AgentData,
  issue: linear.LinearIssue,
  project: store.ProjectWithConfig,
  cfg: store.ProjectConfig,
): Promise<void> {
  if (!hasPreviewLabel(issue, cfg)) return;

  const branch = agent.branch;
  if (!branch) return;

  const issueId = issue.identifier;

  // If runtime is already active or starting, nothing to do
  const existingRt = store.getRuntime(project.path, branch, "REMOTE");
  if (existingRt && !["STOPPED", "FAILED"].includes(existingRt.status)) {
    return;
  }

  log(`PREVIEW-LABEL ${issueId}: label detected, no active runtime — starting remote preview`);
  fireRemotePreview(agent, issue, project, cfg, false);
}

/** Returns true if the issue has the configured preview label. */
function hasPreviewLabel(issue: linear.LinearIssue, cfg: store.ProjectConfig): boolean {
  const name = cfg.LINEAR_PREVIEW_LABEL;
  if (!name || !cfg.LINEAR_API_KEY) return false;
  return issue.labels.nodes.some((l) => l.name === name);
}

/**
 * Fire-and-forget: start (or restart) remote preview.
 * @param restart — if true, stop existing runtime first (agent finished new work).
 */
function fireRemotePreview(
  agent: store.AgentData,
  issue: linear.LinearIssue,
  project: store.ProjectWithConfig,
  cfg: store.ProjectConfig,
  restart: boolean,
): void {
  const branch = agent.branch!;
  const issueId = issue.identifier;
  const projectName = project.name;
  const projectPath = project.path;
  const apiKey = cfg.LINEAR_API_KEY!;
  const issueUuid = issue.id;

  const existing = store.getRuntime(projectPath, branch, "REMOTE");
  const needsCleanup = restart && existing && !["STOPPED", "FAILED"].includes(existing.status);
  const chain = needsCleanup
    ? runtime.cleanupRuntime(projectName, branch, "REMOTE").catch(() => {})
    : Promise.resolve();

  chain.then(() => runtime.startRemote(projectName, branch)).then(async () => {
    const rt = store.getRuntime(projectPath, branch, "REMOTE");
    if (!rt) return;

    const urls: string[] = [];
    if (rt.previewUrl) urls.push(`**app**: ${rt.previewUrl}`);
    if (rt.supabaseUrl) urls.push(`**Supabase**: \`${rt.supabaseUrl}\``);

    const expiresFormatted = rt.expiresAt
      ? new Date(rt.expiresAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })
      : "24h";

    const comment = [
      `## 🌐 Remote Preview${restart ? " (restart)" : ""}`,
      ``,
      ...urls.map((u) => `- ${u}`),
      ``,
      `⏱ **Dostępne do**: ${expiresFormatted}`,
    ].join("\n");

    await linear.addComment(apiKey, issueUuid, comment);

    eventBus.emit("agent:preview", {
      agentId: issueId,
      issueId,
      previewUrl: rt.previewUrl,
      supabaseUrl: rt.supabaseUrl,
    });

    log(`PREVIEW ${issueId}: ✓ remote preview ${restart ? "restarted" : "started"}`);
  }).catch((err) => {
    log(`PREVIEW ${issueId}: FAILED — ${err}`);
  });
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
      if (agent.state) agent.state.agent = "stopped";
      agent.updatedAt = new Date().toISOString();
      store.saveAgent(project.path, agent.issueId, agent);
      log(`Claude not running in ${agent.containerName}, marked ${agent.issueId} as EXITED`);

      // Grab output from container log if no agent response was captured
      try {
        const logR = await cmd.dockerExec(
          agent.containerName,
          'tail -60 /tmp/claude-output.log 2>/dev/null || true',
          { source: "dispatcher", timeout: 10_000, user: "root" },
        );
        if (logR.ok && logR.stdout.trim()) {
          const existing = store.getMessages(project.path, agent.issueId);
          const hasAgentReply = existing.some((m) => m.role === "agent");
          if (!hasAgentReply) {
            const { filterClaudeOutput } = await import("@/lib/agent-aggregate/operations/agent-process");
            const filtered = filterClaudeOutput(logR.stdout.trim());
            if (filtered) {
              const tail = filtered.split("\n").slice(-50).join("\n");
              store.appendMessage(project.path, agent.issueId, "agent", tail);
              log(`Recovered agent output for ${agent.issueId} from container log`);
            }
          }
        }
      } catch {
        // best effort
      }
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
  const lastHuman = humanComments[humanComments.length - 1];

  if (!lastHuman) return;

  // Skip if we already woke for this exact comment
  if (agent.lastWakeCommentAt && lastHuman.createdAt <= agent.lastWakeCommentAt) return;

  log(`WAKE ${agent.issueId}: new human comment`);

  // Mark as processed BEFORE waking to prevent re-trigger if agent exits quickly
  agent.lastWakeCommentAt = lastHuman.createdAt;
  store.saveAgent(project.path, agent.issueId, agent);

  const agg = tryGetAggregate(project.name, agent.issueId);
  if (agg) {
    await agg.wakeAgent(lastHuman.body);
  } else {
    await lifecycle.wake(project.name, agent.issueId, lastHuman.body);
  }
}

async function cleanupOrphans(
  project: store.ProjectWithConfig,
  activeIssueIds: string[]
): Promise<void> {
  const agents = store.listAgents(project.path);
  const TERMINAL = new Set(["DONE", "CANCELLED", "REMOVED", "CLEANUP"]);

  for (const agent of agents) {
    if (TERMINAL.has(agent.status)) continue;
    if (activeIssueIds.includes(agent.issueId)) continue;

    // NEVER clean up agents that are actively running or in an active lifecycle
    if (agent.state?.agent === "running") {
      log(`ORPHAN SKIP ${agent.issueId}: agent is actively running (not in Linear query — may exceed first:50)`);
      continue;
    }
    if (agent.state?.lifecycle === "spawning") {
      log(`ORPHAN SKIP ${agent.issueId}: agent is spawning`);
      continue;
    }

    log(`ORPHAN CLEANUP ${agent.issueId}`);
    const agg = tryGetAggregate(project.name, agent.issueId);
    if (agg) {
      await agg.removeAgent().catch((err) => log(`ORPHAN CLEANUP ${agent.issueId} failed: ${err}`));
    } else {
      await lifecycle.cleanup(project.name, agent.issueId);
    }
  }
}
