// ---------------------------------------------------------------------------
// Agent process operations — extracted from agent-lifecycle.ts
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
import {
  execInContainerAsync,
  killProcesses,
} from "@/lib/docker";
import { eventBus } from "@/lib/event-bus";
import type { AgentState } from "../types";

const CLAUDE_PATTERN = "claude.*--dangerously-skip-permissions";

/** Ring buffer for live Claude output per agent (last N lines, kept in memory). */
const liveOutputBuffers = new Map<string, string[]>();
const LIVE_OUTPUT_MAX_LINES = 50;

export function getLiveOutput(issueId: string, tail = 30): string {
  const buf = liveOutputBuffers.get(issueId);
  if (!buf) return "";
  return buf.slice(-tail).join("\n");
}

function appendLiveOutput(issueId: string, chunk: string): void {
  let buf = liveOutputBuffers.get(issueId);
  if (!buf) { buf = []; liveOutputBuffers.set(issueId, buf); }
  const lines = chunk.split("\n");
  for (const line of lines) {
    if (line.trim()) buf.push(line);
  }
  // Trim to max
  if (buf.length > LIVE_OUTPUT_MAX_LINES * 2) {
    liveOutputBuffers.set(issueId, buf.slice(-LIVE_OUTPUT_MAX_LINES));
  }
}

function clearLiveOutput(issueId: string): void {
  liveOutputBuffers.delete(issueId);
}

/** Track active exec per agent to prevent stale onExit from overwriting status */
const activeExecIds = new Map<string, string>();

/**
 * Filter Claude's exec output — remove docker/service noise, keep only Claude's text.
 */
export function filterClaudeOutput(raw: string): string {
  if (!raw) return "";
  const lines = raw.split("\n").filter((line) => {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/.test(line)) return false;
    if (line.includes("[entrypoint]")) return false;
    if (line.includes("[runtime]")) return false;
    if (line.includes("node --trace-warnings")) return false;
    if (line.includes("Unable to open browser automatically")) return false;
    if (line.includes("Starting framework dev server")) return false;
    if (line.includes("Local dev server ready")) return false;
    if (line.includes("Waiting for framework dev server")) return false;
    if (/^[\s│┌┐└┘─╭╮╰╯┤├]+$/.test(line)) return false;
    return true;
  });
  return lines.join("\n").trim();
}

/** Check if Claude process is running inside the container.
 *  Uses cmd.dockerExec (child_process) instead of dockerode streaming to avoid
 *  blocking the Node.js event loop on Windows named pipes.
 *  Also re-attaches to live output if server was restarted while Claude was running. */
export async function checkAgentProcess(
  agent: store.AgentData,
  state: AgentState,
  projectPath?: string,
): Promise<void> {
  if (!agent.containerName || state.container !== "running") {
    state.agent = "stopped";
    return;
  }
  const r = await cmd.dockerExec(
    agent.containerName,
    `ps aux | grep -E '${CLAUDE_PATTERN}' | grep -v grep | grep -v ' Z ' || true`,
    { source: "checkAgentProcess", timeout: 10_000, user: "root" },
  );
  const isRunning = r.ok && r.stdout.trim().length > 0;
  state.agent = isRunning ? "running" : "stopped";

  // Re-attach: if Claude is running but we have no active exec (server restarted),
  // tail the container output so live output + onExit work again.
  if (isRunning && !activeExecIds.has(agent.issueId)) {
    reattachOutput(agent, projectPath);
  }
}

/** Tail container output for a running Claude process we didn't start (e.g. after server restart). */
function reattachOutput(agent: store.AgentData, projectPath?: string): void {
  if (!agent.containerName) return;
  const issueId = agent.issueId;
  const containerName = agent.containerName;

  console.log(`[agent-process] Reattaching to live output for ${issueId}`);

  const execId = `reattach-${Date.now()}`;
  activeExecIds.set(issueId, execId);

  // Tail the output file written by `tee` in startAgentProcess.
  // If file doesn't exist (agent started before tee was added), we still poll for exit.
  const { spawn: spawnChild } = require("child_process");
  const child = spawnChild("docker", [
    "exec", containerName, "sh", "-c",
    "test -f /tmp/claude-output.log && tail -n 20 -f /tmp/claude-output.log || (echo '[no output file — agent started before output capture was enabled]' && sleep 86400)",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (d: Buffer) => {
    const s = d.toString();
    if (!s.includes("[no output file")) {
      appendLiveOutput(issueId, s);
    }
  });
  child.stderr?.on("data", (d: Buffer) => {
    appendLiveOutput(issueId, d.toString());
  });

  // Poll: when Claude stops, kill the tail and handle exit
  const pollInterval = setInterval(async () => {
    try {
      if (activeExecIds.get(issueId) !== execId) {
        // Another exec took over (e.g. new wake)
        clearInterval(pollInterval);
        child.kill();
        return;
      }
      const check = await cmd.dockerExec(
        containerName,
        `ps aux | grep -E '${CLAUDE_PATTERN}' | grep -v grep | grep -v ' Z ' || true`,
        { source: "reattach-poll", timeout: 5_000, user: "root" },
      );
      const stillRunning = check.ok && check.stdout.trim().length > 0;
      if (!stillRunning) {
        clearInterval(pollInterval);
        child.kill();

        if (activeExecIds.get(issueId) !== execId) return;
        activeExecIds.delete(issueId);

        console.log(`[agent-process] Reattached Claude exited for ${issueId}`);

        // Grab the output for message
        const output = getLiveOutput(issueId, 50);
        const agentResponse = filterClaudeOutput(output);
        if (agentResponse && projectPath) {
          const tail = agentResponse.split("\n").slice(-50).join("\n");
          store.appendMessage(projectPath, issueId, "agent", tail);
        }

        // Update state
        const currentAgent = store.getAgent(projectPath || "", issueId);
        if (currentAgent && currentAgent.state?.agent === "running") {
          currentAgent.state.agent = "stopped";
          if (projectPath) {
            store.saveAgent(projectPath, issueId, currentAgent);
            store.appendLog(projectPath, `agent-${issueId}-lifecycle`, "claude exited (reattached)");
          }
          eventBus.emit("agent:exited", { agentId: issueId, issueId });
        }
      }
    } catch {
      // ignore poll errors
    }
  }, 5_000);
}

/** Launch Claude inside the agent container via exec. */
export async function startAgentProcess(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
  prompt: string,
): Promise<void> {
  if (!agent.containerName) {
    throw new Error(`Agent ${agent.issueId} has no container name`);
  }

  const cfg = store.getProjectConfig(projectPath);

  // Kill any running Claude process before starting new one
  await killProcesses(agent.containerName, CLAUDE_PATTERN);

  clearLiveOutput(agent.issueId);
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const { execId } = await execInContainerAsync(agent.containerName, [
    "sh", "-c",
    `gosu agent claude -p --dangerously-skip-permissions --model sonnet '${escapedPrompt}' 2>&1 | tee /tmp/claude-output.log`,
  ], {
    user: "root",
    workingDir: "/workspace",
    env: [
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
      `LINEAR_API_KEY=${cfg.LINEAR_API_KEY || ""}`,
      `LINEAR_ISSUE_ID=${agent.linearIssueUuid || ""}`,
      `ISSUE_ID=${agent.issueId}`,
    ],
    onData: (chunk) => appendLiveOutput(agent.issueId, chunk),
    onExit: async (exitCode, output) => {
      if (activeExecIds.get(agent.issueId) !== execId) {
        console.log(`[agent-aggregate] Ignoring stale onExit for ${agent.issueId} (exec ${execId.slice(0, 8)})`);
        return;
      }
      console.log(`[agent-aggregate] Claude exited for ${agent.issueId} with code ${exitCode}, output length: ${output?.length || 0}`);

      const agentResponse = filterClaudeOutput(output?.trim() || "");
      if (agentResponse) {
        const tail = agentResponse.split("\n").slice(-50).join("\n");
        store.appendMessage(projectPath, agent.issueId, "agent", tail);
      }

      // Touch changed files to trigger HMR
      if (agent.containerName) {
        try {
          await cmd.dockerExec(agent.containerName,
            'cd /workspace && git diff --name-only HEAD~1 2>/dev/null | xargs -r touch 2>/dev/null || true',
            { source: "agent-aggregate", timeout: 10000 });
        } catch {}
      }

      const currentAgent = store.getAgent(projectPath, agent.issueId);
      if (currentAgent && currentAgent.state?.agent === "running") {
        currentAgent.state.agent = "stopped";
        store.saveAgent(projectPath, agent.issueId, currentAgent);
        store.appendLog(projectPath, `agent-${agent.issueId}-lifecycle`, `claude exited code=${exitCode}`);
        eventBus.emit("agent:exited", { agentId: agent.issueId, issueId: agent.issueId });
      }
    },
  });
  activeExecIds.set(agent.issueId, execId);

  state.agent = "running";
}

/** Stop Claude process (container stays alive). */
export async function stopAgentProcess(
  agent: store.AgentData,
  state: AgentState,
): Promise<void> {
  if (agent.containerName) {
    await killProcesses(agent.containerName, CLAUDE_PATTERN);
  }
  state.agent = "stopped";
}
