// ---------------------------------------------------------------------------
// Wake / Stop / Queue message operations
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, copyFileSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import { eventBus } from "@/lib/event-bus";
import type { AggregateContext } from "../types";
import * as containerOps from "./container";
import * as agentProcessOps from "./agent-process";
import * as serviceOps from "./services";
import * as gitOps from "./git";
import * as taskFiles from "./task-files";
import { writeRulesMd } from "./rule-resolver";

/** Queue a message for the agent without interrupting. Appends to TASK.md + chat history. */
export function queueMessage(ctx: AggregateContext, message: string): void {
  if (!ctx.agent.agentDir) return;

  const tenxDir = join(ctx.agent.agentDir, ".10timesdev");
  if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });
  const taskMdPath = join(tenxDir, "TASK.md");

  if (existsSync(taskMdPath)) {
    appendFileSync(taskMdPath, `\n\n## New instructions from human\n\n${message}\n`);
  }

  store.appendMessage(ctx.projectPath, ctx.issueId, "human", message);
  ctx.opLog("lifecycle", `message queued (agent running): ${message.slice(0, 100)}`);
}

// ---------------------------------------------------------------------------
// Self-healing: ensure workspace has source code, .10timesdev files, images
// ---------------------------------------------------------------------------

/**
 * Check and repair the agent workspace before launching.
 * Handles: missing .git (re-clone + checkout branch), missing CLAUDE.md/RULES.md,
 * fetch + rebase onto default branch (with conflict detection).
 */
async function ensureWorkspaceReady(
  ctx: AggregateContext,
  setProgress: (msg: string) => void,
): Promise<{ conflictMessage?: string }> {
  const agentDir = ctx.agent.agentDir!;
  const branch = ctx.agent.branch || `agent/${ctx.issueId}`;
  let conflictMessage: string | undefined;

  // 1. Check if git repo exists — if not, re-clone and checkout agent branch
  const hasGitRepo = existsSync(join(agentDir, ".git"));
  if (!hasGitRepo) {
    ctx.opLog("wake", `workspace missing .git — re-cloning`);
    setProgress("restoring workspace");

    await gitOps.cloneRepo(ctx.agent, ctx.projectPath, ctx.state, setProgress);

    // Checkout agent branch if it exists on remote
    setProgress("checking out branch");
    try {
      await gitOps.checkoutBranch(agentDir, branch);
    } catch {
      ctx.opLog("wake", `branch ${branch} not found on remote — starting from default`);
    }

    // Copy .env if exists in project
    const envFile = join(ctx.projectPath, ".env");
    if (existsSync(envFile)) {
      copyFileSync(envFile, join(agentDir, ".env"));
    }

    // Ensure orchestrator files are git-ignored
    taskFiles.ensureGitIgnored(agentDir, [".10timesdev", "agent-output.log", ".agent-container", "messages.jsonl"]);
  }

  // 2. Fetch + rebase onto default branch (skip for worktrees without remote)
  if (existsSync(join(agentDir, ".git"))) {
    try {
      setProgress("fetching latest");
      await gitOps.fetchRepo(ctx.agent, ctx.state);

      setProgress("rebasing onto main");
      const rebaseResult = await gitOps.rebaseRepo(ctx.agent, ctx.projectPath, ctx.state, setProgress);

      if (rebaseResult.conflict && rebaseResult.conflictFiles) {
        ctx.opLog("wake", `rebase conflict in ${rebaseResult.conflictFiles.length} file(s)`);
        conflictMessage = [
          "## Rebase conflicts detected during wake",
          "",
          `Rebase onto the default branch failed with conflicts in ${rebaseResult.conflictFiles.length} file(s):`,
          ...rebaseResult.conflictFiles.map((f: string) => `- \`${f}\``),
          "",
          "Please resolve the conflicts:",
          "1. `git add .` then `git rebase --continue`",
          "2. If needed, `git rebase --abort` to undo",
        ].join("\n");
      } else if (!rebaseResult.success && !rebaseResult.conflict) {
        // Non-conflict rebase failure — log but don't block wake
        ctx.opLog("wake", `rebase failed (non-conflict): ${rebaseResult.error || "unknown"}`);
      }
    } catch (err) {
      // Fetch/rebase failure shouldn't block wake — agent can still work
      ctx.opLog("wake", `fetch/rebase failed: ${err}`);
    }
  }

  // 3. Rebuild .10timesdev files (CLAUDE.md, RULES.md, TASK.md)
  setProgress("rebuilding task files");
  const tenxDir = join(agentDir, ".10timesdev");
  if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });

  // RULES.md
  const globalRules = store.getAIRules();
  const projectConfig = store.getProjectConfig(ctx.projectPath);
  const projectRules: store.AIRule[] = JSON.parse(projectConfig.AI_RULES || "[]");
  const hasRules = writeRulesMd(agentDir, [...globalRules, ...projectRules]);

  // CLAUDE.md
  const defaultBranch = await ctx.getDefaultBranch();
  taskFiles.writeClaudeMd(ctx, agentDir, defaultBranch, hasRules);

  // TASK.md — rebuild from messages.jsonl (conversation history)
  const taskMdPath = join(tenxDir, "TASK.md");
  const messages = store.getMessages(ctx.projectPath, ctx.issueId);
  if (messages.length > 0) {
    // Build from stored conversation
    const firstMsg = messages[0];
    let content = `# ${ctx.issueId}: ${ctx.agent.title || "Task"}\n\n`;
    if (ctx.agent.description) {
      content += `${ctx.agent.description}\n\n`;
    }

    // List attachments
    const imagesDir = join(agentDir, ".10timesdev", "images");
    if (existsSync(imagesDir)) {
      const { readdirSync } = require("fs");
      const files = (readdirSync(imagesDir) as string[]).filter((f: string) => !f.startsWith("."));
      if (files.length > 0) {
        content += `## Załączniki\n\n`;
        for (const f of files) {
          content += `- \`.10timesdev/images/${f}\`\n`;
        }
        content += "\n";
      }
    }

    // Conversation history (skip first human message — it's the initial task)
    const conversationMessages = messages.slice(1);
    if (conversationMessages.length > 0) {
      content += "\n---\n\n## Conversation history\n";
      for (const msg of conversationMessages) {
        // Rewrite API URLs to local paths
        let text = msg.text;
        text = text
          .replace(/\/api\/projects\/[^/]+\/agents\/[^/]+\/images\/([^\s)]+)/g, ".10timesdev/images/$1")
          .replace(/\/api\/projects\/[^/]+\/tasks\/images\/([^\s)]+)/g, ".10timesdev/images/$1");

        if (msg.role === "human") {
          content += `\n### Human\n\n${text}\n`;
        } else {
          content += `\n### Agent\n\n${text}\n`;
        }
      }
    }

    writeFileSync(taskMdPath, content, "utf-8");
  } else {
    // No messages — write basic task
    if (!existsSync(taskMdPath)) {
      writeFileSync(taskMdPath, `# ${ctx.issueId}: ${ctx.agent.title || "Task"}\n\n${ctx.agent.description || ""}\n`, "utf-8");
    }
  }

  return { conflictMessage };
}

/** Wake agent: ensure workspace intact → ensure container alive → start Claude process. */
export async function wakeAgent(
  ctx: AggregateContext,
  setProgress: (msg: string) => void,
  message?: string,
  opts?: { reset?: boolean },
): Promise<void> {
  const TERMINAL = new Set(["removed"]);
  if (TERMINAL.has(ctx.state.lifecycle)) {
    throw new Error(`Agent ${ctx.issueId} is in terminal state: ${ctx.state.lifecycle}`);
  }
  // If trackerStatus is terminal but lifecycle is still active, reset it —
  // the user wants to send more instructions (e.g. agent completed work but
  // hasn't been merged yet, or branch was detected as gone prematurely).
  if (ctx.state.trackerStatus === "done" || ctx.state.trackerStatus === "cancelled") {
    if (ctx.state.lifecycle === "active") {
      ctx.opLog("wake", `resetting terminal trackerStatus=${ctx.state.trackerStatus} → in_progress (lifecycle still active)`);
      ctx.state.trackerStatus = "in_progress";
      ctx.state.linearStatus = "in_progress";
      // Also reset merged flag — agent will produce new commits
      ctx.state.git.merged = false;
    } else {
      throw new Error(`Agent ${ctx.issueId} is in terminal state: lifecycle=${ctx.state.lifecycle}, trackerStatus=${ctx.state.trackerStatus}`);
    }
  }

  if (!ctx.agent.agentDir || !ctx.agent.containerName) {
    throw new Error("Agent has no directory or container");
  }

  ctx.beginTransition("running");

  // Self-healing: ensure workspace has source code, .10timesdev files, fetch+rebase
  const { conflictMessage } = await ensureWorkspaceReady(ctx, setProgress);

  // Append conflict info to conversation if rebase had conflicts
  if (conflictMessage) {
    store.appendMessage(ctx.projectPath, ctx.issueId, "human", conflictMessage);
    // Rebuild TASK.md with conflict info included
    const tenxDir = join(ctx.agent.agentDir, ".10timesdev");
    const taskMdPath = join(tenxDir, "TASK.md");
    const content = readFileSync(taskMdPath, "utf-8");
    appendFileSync(taskMdPath, `\n\n## New instructions from human\n\n${conflictMessage}\n`);
  }

  // Append human message if provided
  if (message) {
    const tenxDir = join(ctx.agent.agentDir, ".10timesdev");
    const taskMdPath = join(tenxDir, "TASK.md");
    appendFileSync(taskMdPath, `\n\n## New instructions from human\n\n${message}\n`);
    store.appendMessage(ctx.projectPath, ctx.issueId, "human", message);
  }

  // Ensure container alive
  setProgress("checking container");
  await containerOps.ensureContainerRunning(ctx.agent, ctx.projectPath, ctx.state);

  // Launch Claude
  setProgress("launching agent");
  const hasNewInstructions = !!message || !!conflictMessage;
  const prompt = hasNewInstructions
    ? "Read .10timesdev/TASK.md — at the end of the file there are NEW INSTRUCTIONS from human. Read .10timesdev/CLAUDE.md for rules and response format. Apply the changes according to the new instructions. When done, output the JSON response as described in CLAUDE.md."
    : "Read .10timesdev/TASK.md and .10timesdev/CLAUDE.md. Continue working. When done, output the JSON response as described in CLAUDE.md.";
  await agentProcessOps.startAgentProcess(ctx.agent, ctx.projectPath, ctx.state, prompt, ctx.makeOnExitedCallback());

  ctx.endTransition();
  ctx.opLog("wake", `message=${(message || "resumed").slice(0, 100)}`);
  eventBus.emit("agent:wake", { agentId: ctx.issueId, issueId: ctx.issueId, message: message || "resumed" });
}

/** Stop Claude process + services + container. */
export async function stopAgent(ctx: AggregateContext): Promise<void> {
  ctx.beginTransition("stopped");
  await agentProcessOps.stopAgentProcess(ctx.agent, ctx.state, ctx.projectPath);
  // Stop preview services
  await serviceOps.stopAllServices(ctx.agent, ctx.projectName, ctx.projectPath, ctx.state).catch(() => {});
  ctx.agent.servicesEnabled = false;
  // Stop container — it only serves the agent, no reason to keep it running
  await containerOps.stopContainer(ctx.agent, ctx.state);
  ctx.endTransition();
  ctx.opLog("stop", "claude + services + container stopped");
  eventBus.emit("agent:stopped", { agentId: ctx.issueId, issueId: ctx.issueId });
}
