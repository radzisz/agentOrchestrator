import { existsSync } from "fs";
import { join } from "path";
import * as cmd from "@/lib/cmd";
import * as gitSvc from "@/services/git";
import { eventBus } from "@/lib/event-bus";
import * as store from "@/lib/store";

import * as runtime from "./runtime";
import { getTrackerPollInterval } from "@/lib/issue-trackers/registry";
import { tryGetAggregate, getAggregate, createAggregate } from "@/lib/agent-aggregate";
import { defaultAgentState } from "@/lib/agent-aggregate";
import { getActiveTrackers, resolveTrackerConfig } from "@/lib/issue-trackers/registry";
import { Issue } from "@/lib/issue-trackers/types";
import type { IssueTracker } from "@/lib/issue-trackers/types";

function log(message: string, trackerName?: string) {
  const msg = `[dispatcher] ${message}`;
  console.log(msg);
  const g = globalThis as any;
  const buffers: Map<string, Array<{ ts: string; message: string }>> | undefined = g.__integrationLogs;
  if (buffers) {
    // Write to tracker-specific buffer (or "linear" as general dispatcher log)
    const targets = trackerName ? [trackerName, "linear"] : ["linear"];
    for (const name of targets) {
      let buf = buffers.get(name);
      if (!buf) { buf = []; buffers.set(name, buf); }
      buf.push({ ts: new Date().toISOString(), message: msg });
      if (buf.length > 200) buf.splice(0, buf.length - 200);
    }
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
    const interval = getTrackerPollInterval();
    log(`Next poll in ${interval / 1000}s`);
    scheduleNext(interval);
  }, delayMs);
}

async function tick(): Promise<void> {
  const projects = store.listProjects();

  for (const project of projects) {
    try {
      await processProjectTrackers(project);
    } catch (error) {
      log(`Error processing ${project.name}: ${error}`);
    }
  }

  await cleanupExpiredRuntimes();
}

async function processProjectTrackers(project: store.ProjectWithConfig): Promise<void> {
  if (!existsSync(join(project.path, ".git"))) {
    log(`SKIP ${project.name}: no git repository at ${project.path}`);
    return;
  }

  const trackers = getActiveTrackers(project.path);
  const allActiveIssueIds: string[] = [];

  for (const tracker of trackers) {
    try {
      const issues = await tracker.pollIssues(project.path);
      log(`Poll ${project.name} [${tracker.name}]: ${issues.length} issues`, tracker.name);

      // Log state distribution for debugging
      const stateCounts = new Map<string, number>();
      for (const issue of issues) {
        const s = issue.rawState;
        stateCounts.set(s, (stateCounts.get(s) || 0) + 1);
      }
      const stateStr = [...stateCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
      if (stateStr) log(`  States: ${stateStr}`, tracker.name);

      for (const issueData of issues) {
        allActiveIssueIds.push(issueData.identifier);
        try {
          const issue = new Issue(issueData, tracker, project.path);
          await processTrackerIssue(project, issue);
        } catch (error) {
          log(`Error on ${issueData.identifier}: ${error}`, tracker.name);
        }
      }
    } catch (error) {
      log(`${tracker.name} poll error for ${project.name}: ${error}`, tracker.name);
    }
  }

  await cleanupOrphans(project, allActiveIssueIds);
}

async function processTrackerIssue(
  project: store.ProjectWithConfig,
  issue: Issue,
): Promise<void> {
  const issueId = issue.identifier;
  const agent = store.getAgent(project.path, issueId);

  // ---- TODO → SPAWN ----
  if (issue.phase === "todo") {
    if (!agent || !agent.spawned) {
      // Guard: don't spawn if already spawning (prevents duplicate spawns across ticks)
      if (agent?.currentOperation?.name === "spawn" || agent?.state?.lifecycle === "spawning") {
        log(`SPAWN ${issueId}: SKIP — already spawning (op=${agent?.currentOperation?.name}, lifecycle=${agent?.state?.lifecycle})`);
        return;
      }
      // Guard: don't retry if previous spawn failed (agent exists but stopped with error)
      if (agent?.state?.agent === "stopped" && agent?.spawned === false) {
        log(`SPAWN ${issueId}: SKIP — previous spawn failed (agent stopped, spawned=false)`);
        return;
      }
      log(`SPAWN ${issueId}: "${issue.title}" (phase=${issue.phase}, hasAgent=${!!agent}, spawned=${agent?.spawned})`);
      try {
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
        await agg.spawnAgent({ trackerIssue: issue.data });

        // Post "Agent started" comment only on external trackers (Linear etc.)
        // Local tracker doesn't need it — it just pollutes comments and triggers false wake
        if (issue.data.source !== "local") {
          const ports = agg.agentData.portSlot != null ? store.getPortsForSlot(agg.agentData.portSlot) : null;
          const portInfo = ports ? `\nSlot: ${ports.slot} (ports: ${ports.frontend[0]}, ${ports.backend[0]}...)` : "";
          await issue.addComment(`🤖 Agent started\n\nProject: ${project.name}${portInfo}\nBranch: agent/${issueId}`);
        }

        log(`SPAWN ${issueId}: ✓ success`);
      } catch (spawnErr) {
        log(`SPAWN ${issueId}: ✗ FAILED — ${spawnErr}`);
        return;
      }

      await issue.transitionTo("in_progress");
    }
    return;
  }

  // ---- IN PROGRESS ----
  if (issue.phase === "in_progress") {
    let currentAgent = agent;

    if (!currentAgent) {
      // Check registry — aggregate may exist from an in-progress spawn
      const existingAgg = tryGetAggregate(project.name, issueId);
      if (existingAgg?.currentOperation?.name === "spawn") {
        log(`RE-SPAWN ${issueId}: SKIP — spawn already in progress`);
        return;
      }
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
        await agg.spawnAgent({ trackerIssue: issue.data });
        log(`RE-SPAWN ${issueId}: ✓ success`);
      } catch (spawnErr) {
        log(`RE-SPAWN ${issueId}: ✗ FAILED — ${spawnErr}`);
      }
      currentAgent = store.getAgent(project.path, issueId);
    }

    if (currentAgent) {
      // Skip all processing if spawn never completed
      if (!currentAgent.spawned && currentAgent.state?.agent === "stopped") {
        log(`${issueId}: SKIP — spawn never completed (spawned=false, stopped)`);
        return;
      }
      await ensureClaudeRunning(currentAgent, project);

      // Reassign to creator when agent has stopped (assignee mode)
      const reassignAgg = tryGetAggregate(project.name, issueId);
      if (reassignAgg && reassignAgg.snapshot.agent === "stopped" && reassignAgg.snapshot.lifecycle === "active" && !currentAgent.reassigned) {
        try {
          await issue.reassignOnDone();
          reassignAgg.markReassigned();
          log(`REASSIGN ${issueId}: reassigned to creator`);
        } catch (err) {
          log(`REASSIGN ${issueId}: failed — ${err}`);
        }
      }

      if (issue.canDetectWake) {
        await checkWakeTrigger(currentAgent, issue, project);
      }

      if (issue.canManageLabels) {
        await checkPreviewLabel(currentAgent, issue, project);
      }

      // "🤖 Gotowe" detection
      if (issue.canDetectWake) {
        const comments = await issue.getComments();
        const agentDone = comments.find((c) => c.body.startsWith("🤖 Gotowe"));

        if (agentDone && !currentAgent.previewed) {
          log(`PREVIEW ${issueId}: agent completed`);

          // CDM / local-source agents: auto rebase + merge + cleanup
          if (currentAgent.trackerSource === "local") {
            log(`AUTO-MERGE ${issueId}: local source — auto rebase & merge`);
            const autoAgg = tryGetAggregate(project.name, issueId) || getAggregate(project.name, issueId);
            autoAgg.markPreviewed();
            try {
              await autoAgg.mergeAndClose({ cleanup: true, closeIssue: true });
              log(`AUTO-MERGE ${issueId}: ✓ success`);
            } catch (mergeErr) {
              log(`AUTO-MERGE ${issueId}: ✗ FAILED — ${mergeErr}`);
              // Fall back to normal in_review flow
              await issue.transitionTo("in_review");
            }
          } else {
            await issue.transitionTo("in_review");

            const previewAgg = tryGetAggregate(project.name, issueId);
            if (previewAgg) {
              previewAgg.markPreviewed();
            }

            if (issue.canManageLabels && hasPreviewLabel(issue) && currentAgent.branch) {
              fireRemotePreview(currentAgent, issue, project, true);
            }

            eventBus.emit("agent:preview", {
              agentId: issueId,
              issueId,
            });
          }
        }
      }
    }
    return;
  }

  // ---- IN REVIEW ----
  if (issue.phase === "in_review") {
    if (!agent) return;

    if (issue.canManageLabels) {
      await checkPreviewLabel(agent, issue, project);
    }

    if (issue.canDetectWake) {
      const comments = await issue.getComments();
      const humanOk = comments.find(
        (c) => !c.isBot && /^OK/i.test(c.body)
      );

      if (humanOk && !agent.notified) {
        log(`READY TO MERGE ${issueId}: ${issue.title}`);
        const notifyAgg = tryGetAggregate(project.name, issueId);
        if (notifyAgg) {
          notifyAgg.markNotified();
        } else {
          // Fallback: no aggregate, save directly via store
          agent.notified = true;
          store.saveAgent(project.path, issueId, agent);
        }
        store.appendLog(project.path, `agent-${issueId}-lifecycle`, `ready_to_merge approved_by=${humanOk.authorName}`);
      }
    }
    return;
  }

  // ---- DONE / CANCELLED → CLEANUP ----
  if (issue.phase === "done" || issue.phase === "cancelled") {
    if (agent && agent.state?.trackerStatus !== "done" && agent.state?.trackerStatus !== "cancelled" && agent.state?.lifecycle !== "removed") {
      log(`CLEANUP ${issueId}`);
      const cleanupAgg = getAggregate(project.name, issueId);
      await cleanupAgg.removeAgent().catch((err) => log(`CLEANUP ${issueId} failed: ${err}`));
    }
    return;
  }

  // ---- Unhandled phase ----
  log(`SKIP ${issueId}: unhandled phase "${issue.phase}" (rawState="${issue.rawState}")`);
}


/**
 * Check if the preview label is present on the issue.
 * If yes and no active runtime → start remote preview.
 */
async function checkPreviewLabel(
  agent: store.AgentData,
  issue: Issue,
  project: store.ProjectWithConfig,
): Promise<void> {
  if (!hasPreviewLabel(issue)) return;

  const branch = agent.branch;
  if (!branch) return;

  const issueId = issue.identifier;

  // If runtime is already active or starting, nothing to do
  const existingRt = store.getRuntime(project.path, branch, "REMOTE");
  if (existingRt && !["STOPPED", "FAILED"].includes(existingRt.status)) {
    return;
  }

  // Cooldown: don't retry failed/stopped previews more than once per 10 minutes
  if (existingRt?.updatedAt) {
    const elapsed = Date.now() - new Date(existingRt.updatedAt).getTime();
    if (elapsed < 10 * 60 * 1000) return;
  }

  // Don't start preview if agent hasn't pushed the branch yet
  if (!agent.state?.git?.aheadBy && !agent.state?.git?.lastCommit) {
    return;
  }

  // Verify branch exists on remote before triggering deploy
  const branchOnRemote = await gitSvc.branchExistsOnRemote(project.path, branch);
  if (!branchOnRemote) {
    log(`PREVIEW-LABEL ${issueId}: branch ${branch} not on remote yet — skipping`);
    return;
  }

  log(`PREVIEW-LABEL ${issueId}: label detected, no active runtime — starting remote preview`);
  fireRemotePreview(agent, issue, project, false);
}

/** Returns true if the issue has the configured preview label. */
function hasPreviewLabel(issue: Issue): boolean {
  if (!issue.canManageLabels) return false;
  const linearConfig = resolveTrackerConfig(issue.projectPath, "linear");
  const name = linearConfig?.previewLabel;
  if (!name || !linearConfig?.apiKey) return false;
  return issue.hasLabel(name);
}

/**
 * Fire-and-forget: start (or restart) remote preview.
 */
function fireRemotePreview(
  agent: store.AgentData,
  issue: Issue,
  project: store.ProjectWithConfig,
  restart: boolean,
): void {
  const branch = agent.branch!;
  const issueId = issue.identifier;
  const projectName = project.name;
  const projectPath = project.path;

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

    await issue.addComment(comment);

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

/**
 * Ensure the AI agent process is running inside the agent's container.
 * Delegates to aggregate's refreshAgent() which handles container/process checks,
 * output recovery, and state derivation.
 */
async function ensureClaudeRunning(
  agent: store.AgentData,
  project: store.ProjectWithConfig
): Promise<void> {
  if (!agent.containerName) return;

  const agg = tryGetAggregate(project.name, agent.issueId);
  if (!agg) return;

  // Capture container state before refresh to detect crashes.
  // Only auto-wake if container JUST died (was running, now it's not).
  // Don't wake if container was already stopped — that's intentional.
  const containerBefore = agg.snapshot.container;

  await agg.refreshAgent({ force: true });
  const snap = agg.snapshot;

  if (containerBefore === "running" && snap.container !== "running" &&
      snap.lifecycle === "active" && !snap.transition && !agg.currentOperation) {
    log(`Container crashed, waking ${agent.issueId}`);
    try {
      await agg.wakeAgent();
    } catch (e) {
      log(`Wake failed ${agent.issueId}: ${e}`);
    }
  }
}

async function checkWakeTrigger(
  agent: store.AgentData,
  issue: Issue,
  project: store.ProjectWithConfig
): Promise<void> {
  if (!agent.containerName) return;
  const wakeAgg = tryGetAggregate(project.name, agent.issueId);
  if (!wakeAgg || wakeAgg.snapshot.agent !== "stopped") return;

  const comments = await issue.getComments();
  const humanComments = comments.filter((c) => !c.isBot);
  const lastHuman = humanComments[humanComments.length - 1];

  if (!lastHuman) return;

  if (agent.lastWakeCommentAt && lastHuman.createdAt <= agent.lastWakeCommentAt) return;

  log(`WAKE ${agent.issueId}: new human comment`);

  agent.lastWakeCommentAt = lastHuman.createdAt;
  store.saveAgent(project.path, agent.issueId, agent);

  const commentAgg = getAggregate(project.name, agent.issueId);
  commentAgg.reload(); // pick up lastWakeCommentAt before wakeAgent's persist() overwrites it
  await commentAgg.wakeAgent(lastHuman.body);
}

async function cleanupOrphans(
  project: store.ProjectWithConfig,
  activeIssueIds: string[]
): Promise<void> {
  const agents = store.listAgents(project.path);

  for (const agent of agents) {
    const ts = agent.state?.trackerStatus;
    const lc = agent.state?.lifecycle;
    if (ts === "done" || ts === "cancelled" || lc === "removed") continue;
    if (activeIssueIds.includes(agent.issueId)) continue;

    // NEVER clean up agents with active lifecycle — they may be running,
    // waiting for review, or just not returned by the tracker query (e.g. Linear first:50 limit).
    // Only clean up agents that are truly orphaned (pending lifecycle with no tracker match).
    if (agent.state?.lifecycle === "active" || agent.state?.lifecycle === "spawning") {
      log(`ORPHAN SKIP ${agent.issueId}: lifecycle=${agent.state.lifecycle} (not in tracker query — may exceed limit)`);
      continue;
    }
    if (agent.state?.agent === "running") {
      log(`ORPHAN SKIP ${agent.issueId}: agent is actively running`);
      continue;
    }

    log(`ORPHAN CLEANUP ${agent.issueId}`);
    const agg = tryGetAggregate(project.name, agent.issueId);
    const orphanAgg = agg || getAggregate(project.name, agent.issueId);
    await orphanAgg.removeAgent().catch((err) => log(`ORPHAN CLEANUP ${agent.issueId} failed: ${err}`));
  }
}
