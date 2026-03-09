// ---------------------------------------------------------------------------
// Spawn / Restore operations
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
import * as portManager from "@/services/port-manager";
import { eventBus } from "@/lib/event-bus";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";
import type { TrackerIssue } from "@/lib/issue-trackers/types";
import type { AggregateContext } from "../types";
import * as containerOps from "./container";
import * as agentProcessOps from "./agent-process";
import * as gitOps from "./git";
import * as taskFiles from "./task-files";
import { rewriteImageUrls } from "./task-files";
import { writeRulesMd } from "./rule-resolver";
import * as trackerOps from "./tracker";

/** Spawn a new agent: clone → create container → start Claude process. */
export async function spawnAgent(
  ctx: AggregateContext,
  opts: {
    trackerIssue?: TrackerIssue;
    linearIssueUuid?: string;
    customPrompt?: string;
  },
  setProgress: (msg: string) => void,
): Promise<void> {
  const agentDir = join(ctx.projectPath, ".10timesdev", "agents", ctx.issueId, "git");

  // Resolve TrackerIssue — either provided directly or fetched via tracker abstraction
  let trackerIssue = opts.trackerIssue;
  if (!trackerIssue && opts.linearIssueUuid) {
    setProgress("fetching tracker issue");
    trackerIssue = await trackerOps.fetchIssue("linear", opts.linearIssueUuid, ctx.projectPath) ?? undefined;
    if (!trackerIssue) throw new Error(`Issue ${ctx.issueId} not found in tracker`);
  }
  if (!trackerIssue) throw new Error("Either trackerIssue or linearIssueUuid is required");

  // Guard: project must be a git repository
  if (!existsSync(join(ctx.projectPath, ".git"))) {
    throw new Error(
      `Project path "${ctx.projectPath}" is not a git repository. ` +
      `Initialize git first (git init) before spawning agents.`,
    );
  }

  // Update agent record
  ctx.agent.title = trackerIssue.title;
  ctx.agent.description = trackerIssue.description || undefined;
  ctx.agent.createdBy = trackerIssue.createdBy || undefined;
  ctx.agent.issueCreatedAt = trackerIssue.createdAt || undefined;
  ctx.agent.trackerSource = trackerIssue.source;
  ctx.agent.trackerExternalId = trackerIssue.externalId;
  if (trackerIssue.source === "linear") {
    ctx.agent.linearIssueUuid = trackerIssue.externalId;
  }
  ctx.agent.branch = `agent/${ctx.issueId}`;
  ctx.agent.agentDir = agentDir;
  ctx.state.lifecycle = "spawning";
  ctx.state.trackerStatus = "in_progress";
  ctx.state.linearStatus = "in_progress";
  ctx.beginTransition("running");

  // Allocate port
  const ports = portManager.allocate(ctx.projectName, ctx.issueId);
  ctx.agent.portSlot = ports.slot;
  ctx.agent.containerName = `agent-${ctx.issueId}`;

  store.cacheAgent(ctx.projectPath, ctx.issueId, ctx.agent);

  try {
    // Always full clone — agent needs remote to push, rebase, resolve conflicts
    setProgress("cloning repository");
    await gitOps.cloneRepo(ctx.agent, ctx.projectPath, ctx.state);
    ctx.persist();

    // Copy .env if exists
    const envFile = join(ctx.projectPath, ".env");
    if (existsSync(envFile)) {
      writeFileSync(join(agentDir, ".env"), readFileSync(envFile));
    }

    // Install dependencies
    setProgress("installing dependencies");
    if (existsSync(join(agentDir, "pnpm-lock.yaml"))) {
      await cmd.run("pnpm install --frozen-lockfile", { cwd: agentDir, source: "agent-aggregate", timeout: 120000 });
    } else if (existsSync(join(agentDir, "package-lock.json"))) {
      await cmd.run("npm ci", { cwd: agentDir, source: "agent-aggregate", timeout: 120000 });
    }

    // Create agent branch, add gitignore entries, and commit
    setProgress("setting up branch");
    taskFiles.ensureGitIgnored(agentDir, [".10timesdev", "agent-output.log", ".agent-container", "messages.jsonl"]);
    await gitOps.setupAgentBranch(agentDir, ctx.agent.branch || `agent/${ctx.issueId}`);

    // Migrate legacy orchestrator files
    const tenxDir = join(agentDir, ".10timesdev");
    if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });

    // Write TASK.md (downloads images) and CLAUDE.md
    setProgress("writing task files");
    const linearCfgForImages = resolveTrackerConfig(ctx.projectPath, "linear");
    await taskFiles.writeTaskMd(agentDir, trackerIssue, { linearApiKey: linearCfgForImages?.apiKey, projectPath: ctx.projectPath });
    const defaultBranch = await ctx.getDefaultBranch();

    // Write AI rules (RULES.md) and CLAUDE.md
    const globalRules = store.getAIRules();
    const projectConfig = store.getProjectConfig(ctx.projectPath);
    const projectRules: import("@/lib/store").AIRule[] = JSON.parse(projectConfig.AI_RULES || "[]");
    const hasRules = writeRulesMd(agentDir, [...globalRules, ...projectRules]);

    taskFiles.writeClaudeMd(ctx, agentDir, defaultBranch, hasRules);

    // Log initial message (skip if retrying — messages already exist)
    const existingMessages = store.getMessages(ctx.projectPath, ctx.issueId);
    if (existingMessages.length === 0) {
      let initialMessage = opts.customPrompt || `${trackerIssue.identifier}: ${trackerIssue.title}\n\n${trackerIssue.description || ""}`;

      // Append human comments (they may contain inline images)
      if (!opts.customPrompt && trackerIssue.comments && trackerIssue.comments.length > 0) {
        for (const c of trackerIssue.comments) {
          initialMessage += `\n\n---\n**${c.authorName}:**\n${c.body}`;
        }
      }

      // Rewrite image URLs to our API so browser can display them (Linear CDN requires auth)
      const imagesDir = join(agentDir, ".10timesdev", "images");
      initialMessage = rewriteImageUrls(initialMessage, ctx.projectName, ctx.issueId, imagesDir);

      store.appendMessage(ctx.projectPath, ctx.issueId, "human", initialMessage);
    }

    // Create container
    setProgress("creating Docker container");
    await containerOps.createContainer(ctx.agent, ctx.projectPath, ctx.state);

    // Launch agent
    setProgress("launching agent");
    const prompt = opts.customPrompt ||
      "Read .10timesdev/TASK.md — this is your task. Read .10timesdev/CLAUDE.md — it contains your identity, rules, allowed git operations, and response format. Complete the task. When done, output the JSON response as described in CLAUDE.md.";
    await agentProcessOps.startAgentProcess(ctx.agent, ctx.projectPath, ctx.state, prompt, ctx.makeOnExitedCallback());

    ctx.state.lifecycle = "active";
    ctx.agent.spawned = true;
    ctx.endTransition();

    ctx.opLog("spawn", `container=agent-${ctx.issueId} branch=agent/${ctx.issueId} slot=${ports.slot}`);
    eventBus.emit("agent:spawned", {
      agentId: ctx.issueId,
      issueId: ctx.issueId,
      projectName: ctx.projectName,
      containerName: `agent-${ctx.issueId}`,
      branch: `agent/${ctx.issueId}`,
    });
  } catch (error) {
    const safeMsg = sanitizeError(error);
    ctx.state.agent = "stopped";
    ctx.state.lifecycle = "active";
    ctx.endTransition();
    ctx.opLog("spawn", `error: ${safeMsg}`);
    eventBus.emit("agent:error", { agentId: ctx.issueId, issueId: ctx.issueId, error: safeMsg });
    throw new Error(safeMsg);
  }
}

/** Set initial restore state synchronously so UI reflects immediately. */
export function prepareRestore(ctx: AggregateContext): void {
  ctx.state.lifecycle = "spawning";
  ctx.agent.currentOperation = {
    name: "restore",
    startedAt: new Date().toISOString(),
    progress: "preparing",
  };
  ctx.persist();
}

/** Restore a removed agent: re-clone from git, create container, launch Claude. */
export async function restoreAgent(
  ctx: AggregateContext,
  opts: { fromBranch: string; setInProgress?: boolean },
  setProgress: (msg: string) => void,
): Promise<void> {
  // lifecycle was already set to "spawning" by prepareRestore()
  if (ctx.state.lifecycle !== "spawning") {
    throw new Error(`Agent ${ctx.issueId} is not in spawning state (lifecycle=${ctx.state.lifecycle})`);
  }

  const agentDir = join(ctx.projectPath, ".10timesdev", "agents", ctx.issueId, "git");

  // Guard: project must be a git repository
  if (!existsSync(join(ctx.projectPath, ".git"))) {
    throw new Error(
      `Project path "${ctx.projectPath}" is not a git repository. ` +
      `Initialize git first (git init) before restoring agents.`,
    );
  }

  // Reset state
  ctx.state.lifecycle = "spawning";
  ctx.state.container = "missing";
  ctx.state.agent = "stopped";
  ctx.beginTransition("running");
  ctx.state.git.merged = false;
  ctx.state.git.op = "idle";
  ctx.agent.agentDir = agentDir;
  ctx.agent.branch = `agent/${ctx.issueId}`;
  ctx.agent.containerName = `agent-${ctx.issueId}`;

  if (opts.setInProgress) {
    ctx.state.trackerStatus = "in_progress";
    ctx.state.linearStatus = "in_progress";
  }

  // Allocate port
  const ports = portManager.allocate(ctx.projectName, ctx.issueId);
  ctx.agent.portSlot = ports.slot;

  ctx.persist();

  try {
    // Clone repo
    setProgress("cloning repository");
    await gitOps.cloneRepo(ctx.agent, ctx.projectPath, ctx.state);

    // Checkout the chosen branch if it's not the default
    const defaultBranch = await ctx.getDefaultBranch();
    if (opts.fromBranch !== defaultBranch) {
      setProgress("checking out branch");
      await gitOps.checkoutBranch(agentDir, opts.fromBranch);
    }

    // Copy .env if exists
    const envFile = join(ctx.projectPath, ".env");
    if (existsSync(envFile)) {
      writeFileSync(join(agentDir, ".env"), readFileSync(envFile));
    }

    // Install dependencies
    setProgress("installing dependencies");
    if (existsSync(join(agentDir, "pnpm-lock.yaml"))) {
      await cmd.run("pnpm install --frozen-lockfile", { cwd: agentDir, source: "agent-aggregate", timeout: 120000 });
    } else if (existsSync(join(agentDir, "package-lock.json"))) {
      await cmd.run("npm ci", { cwd: agentDir, source: "agent-aggregate", timeout: 120000 });
    }

    // Ensure orchestrator files are git-ignored and committed on agent branch
    taskFiles.ensureGitIgnored(agentDir, [".10timesdev", "agent-output.log", ".agent-container", "messages.jsonl"]);
    await gitOps.commitGitIgnoreIfNeeded(agentDir);

    // Write task & claude files
    setProgress("writing task files");
    const tenxDir = join(agentDir, ".10timesdev");
    if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });

    // Write TASK.md (simple version — no Linear fetch needed)
    const taskMdPath = join(tenxDir, "TASK.md");
    if (!existsSync(taskMdPath)) {
      writeFileSync(taskMdPath, `# ${ctx.issueId}: ${ctx.agent.title || "Task"}\n\n${ctx.agent.description || ""}\n`, "utf-8");
    }
    const restoreDefaultBranch = await ctx.getDefaultBranch();

    // Write AI rules (RULES.md) and CLAUDE.md
    const restoreGlobalRules = store.getAIRules();
    const restoreProjectConfig = store.getProjectConfig(ctx.projectPath);
    const restoreProjectRules: import("@/lib/store").AIRule[] = JSON.parse(restoreProjectConfig.AI_RULES || "[]");
    const restoreHasRules = writeRulesMd(agentDir, [...restoreGlobalRules, ...restoreProjectRules]);

    taskFiles.writeClaudeMd(ctx, agentDir, restoreDefaultBranch, restoreHasRules);

    // Update tracker status if requested — use abstraction
    if (opts.setInProgress && (ctx.agent.trackerExternalId || ctx.agent.linearIssueUuid)) {
      setProgress("updating tracker status");
      await trackerOps.transitionTo(ctx.agent, ctx.projectPath, "in_progress");
    }

    // Create container
    setProgress("creating Docker container");
    await containerOps.createContainer(ctx.agent, ctx.projectPath, ctx.state);

    // Launch Claude
    setProgress("launching agent");
    const prompt = "Read .10timesdev/TASK.md and .10timesdev/CLAUDE.md. Continue working on the task. When done, output the JSON response as described in CLAUDE.md.";
    await agentProcessOps.startAgentProcess(ctx.agent, ctx.projectPath, ctx.state, prompt, ctx.makeOnExitedCallback());

    ctx.state.lifecycle = "active";
    ctx.agent.spawned = true;
    ctx.endTransition();

    ctx.opLog("restore", `restored from branch=${opts.fromBranch} slot=${ports.slot}`);
    eventBus.emit("agent:spawned", {
      agentId: ctx.issueId,
      issueId: ctx.issueId,
      projectName: ctx.projectName,
      containerName: `agent-${ctx.issueId}`,
      branch: `agent/${ctx.issueId}`,
    });
  } catch (error) {
    const safeMsg = sanitizeError(error);
    ctx.state.agent = "stopped";
    ctx.state.lifecycle = "active";
    ctx.endTransition();
    ctx.opLog("restore", `error: ${safeMsg}`);
    throw new Error(safeMsg);
  }
}

function sanitizeError(err: unknown): string {
  return String(err).replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}
