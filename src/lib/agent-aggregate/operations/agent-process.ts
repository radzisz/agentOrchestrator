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
 *  blocking the Node.js event loop on Windows named pipes. */
export async function checkAgentProcess(
  agent: store.AgentData,
  state: AgentState,
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
  state.agent = r.ok && r.stdout.trim().length > 0 ? "running" : "stopped";
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
    `gosu agent claude -p --dangerously-skip-permissions --model sonnet '${escapedPrompt}' 2>&1`,
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
