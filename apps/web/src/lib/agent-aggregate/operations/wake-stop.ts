// ---------------------------------------------------------------------------
// Wake / Stop / Queue message operations
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import { eventBus } from "@/lib/event-bus";
import type { AggregateContext } from "../types";
import * as containerOps from "./container";
import * as agentProcessOps from "./agent-process";
import * as serviceOps from "./services";

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

/** Wake agent: ensure container alive → start Claude process. */
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
  if (ctx.state.trackerStatus === "done" || ctx.state.trackerStatus === "cancelled") {
    throw new Error(`Agent ${ctx.issueId} is in terminal tracker status: ${ctx.state.trackerStatus}`);
  }

  if (!ctx.agent.agentDir || !ctx.agent.containerName) {
    throw new Error("Agent has no directory or container");
  }

  ctx.beginTransition("running");

  const tenxDir = join(ctx.agent.agentDir, ".10timesdev");
  if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });
  const taskMdPath = join(tenxDir, "TASK.md");

  if (!existsSync(taskMdPath)) {
    writeFileSync(taskMdPath, `# ${ctx.agent.issueId}: ${ctx.agent.title || "Task"}\n\n${ctx.agent.description || ""}\n`, "utf-8");
  }

  if (opts?.reset) {
    const content = readFileSync(taskMdPath, "utf-8");
    const cleaned = content.replace(/\n\n## New instructions from human\n\n[\s\S]*$/m, "");
    writeFileSync(taskMdPath, cleaned, "utf-8");
  }

  if (message) {
    appendFileSync(taskMdPath, `\n\n## New instructions from human\n\n${message}\n`);
    store.appendMessage(ctx.projectPath, ctx.issueId, "human", message);
  }

  // Ensure container alive
  setProgress("checking container");
  await containerOps.ensureContainerRunning(ctx.agent, ctx.projectPath, ctx.state);

  // Launch Claude
  setProgress("launching agent");
  const prompt = message
    ? "Read .10timesdev/TASK.md — at the end of the file there are NEW INSTRUCTIONS from human. Read .10timesdev/CLAUDE.md. Apply the changes according to the new instructions. When done, comment on Linear."
    : "Read .10timesdev/TASK.md and .10timesdev/CLAUDE.md. Continue working. When done, comment on Linear.";
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
