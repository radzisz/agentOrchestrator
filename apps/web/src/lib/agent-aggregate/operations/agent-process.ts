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
import { resolveProviderConfig, resolveProviderInstance, getProviderDriver } from "../ai-provider";
import type { AIProviderDriver } from "../ai-provider";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";

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

/** Resolve the AI provider driver for a given agent. */
function resolveDriver(agent: store.AgentData, projectPath?: string): AIProviderDriver {
  const cfg = projectPath ? store.getProjectConfig(projectPath) : {};
  const providerCfg = resolveProviderConfig(agent, cfg);
  return getProviderDriver(providerCfg);
}

/**
 * Filter agent output — delegates to the appropriate provider driver.
 * Kept as a named export for backward compatibility (dispatcher, aggregate, etc.).
 */
export function filterClaudeOutput(raw: string, driver?: AIProviderDriver): string {
  if (driver) return driver.filterOutput(raw);
  // Default: use Claude Code driver filter (backward compat)
  const { getProviderDriver: gpd, DEFAULT_PROVIDER } = require("../ai-provider");
  return gpd(DEFAULT_PROVIDER).filterOutput(raw);
}

/** Check if Claude process is running inside the container.
 *  Returns the detected status without mutating state.
 *  Also re-attaches to live output if server was restarted while Claude was running. */
export async function checkAgentProcess(
  agent: store.AgentData,
  containerStatus: AgentState["container"],
  projectPath?: string,
  onAgentExited?: () => void,
): Promise<AgentState["agent"]> {
  if (!agent.containerName || containerStatus !== "running") {
    return "stopped";
  }
  const driver = resolveDriver(agent, projectPath);
  const r = await cmd.dockerExec(
    agent.containerName,
    `ps aux | grep -E '${driver.processPattern}' | grep -v grep | grep -v ' Z ' || true`,
    { source: "checkAgentProcess", timeout: 10_000, user: "root" },
  );
  const isRunning = r.ok && r.stdout.trim().length > 0;

  // Re-attach: if agent is running but we have no active exec (server restarted),
  // tail the container output so live output + onExit work again.
  if (isRunning && !activeExecIds.has(agent.issueId)) {
    reattachOutput(agent, projectPath, onAgentExited);
  }

  return isRunning ? "running" : "stopped";
}

/** Tail container output for a running agent process we didn't start (e.g. after server restart).
 *  @param onAgentExited — optional callback injected by aggregate, called when process exits. */
export function reattachOutput(agent: store.AgentData, projectPath?: string, onAgentExited?: () => void): void {
  if (!agent.containerName) return;
  const issueId = agent.issueId;
  const containerName = agent.containerName;
  const driver = resolveDriver(agent, projectPath);

  console.log(`[agent-process] Reattaching to live output for ${issueId}`);

  const execId = `reattach-${Date.now()}`;
  activeExecIds.set(issueId, execId);

  // Tail the output file written by `tee` in startAgentProcess.
  // If file doesn't exist (agent started before tee was added), we still poll for exit.
  const { spawn: spawnChild } = require("child_process");
  const outputLog = driver.outputLogPath;
  const child = spawnChild("docker", [
    "exec", containerName, "sh", "-c",
    `test -f ${outputLog} && tail -n 20 -f ${outputLog} || (echo '[no output file — agent started before output capture was enabled]' && sleep 86400)`,
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
        `ps aux | grep -E '${driver.processPattern}' | grep -v grep | grep -v ' Z ' || true`,
        { source: "reattach-poll", timeout: 5_000, user: "root" },
      );
      const stillRunning = check.ok && check.stdout.trim().length > 0;
      if (!stillRunning) {
        clearInterval(pollInterval);
        child.kill();

        if (activeExecIds.get(issueId) !== execId) return;
        activeExecIds.delete(issueId);

        console.log(`[agent-process] Reattached agent exited for ${issueId}`);

        // Grab the output for message
        const output = getLiveOutput(issueId, 50);
        const agentResponse = driver.filterOutput(output);
        if (agentResponse && projectPath) {
          const tail = agentResponse.split("\n").slice(-50).join("\n");
          store.appendMessage(projectPath, issueId, "agent", tail);
        }

        // Notify aggregate via injected callback (preferred path)
        if (onAgentExited) {
          if (projectPath) {
            store.appendLog(projectPath, `agent-${issueId}-lifecycle`, "agent exited (reattached)");
          }
          onAgentExited();
        } else {
          // Fallback: direct state update (legacy path)
          const currentAgent = store.getAgent(projectPath || "", issueId);
          if (currentAgent && currentAgent.state?.agent === "running") {
            currentAgent.state.agent = "stopped";
            if (projectPath) {
              store.saveAgent(projectPath, issueId, currentAgent);
              store.appendLog(projectPath, `agent-${issueId}-lifecycle`, "agent exited (reattached)");
            }
            eventBus.emit("agent:exited", { agentId: issueId, issueId });
          }
        }
      }
    } catch {
      // ignore poll errors
    }
  }, 5_000);
}

/** Launch Claude inside the agent container via exec.
 *  @param onAgentExited — callback injected by aggregate, called when Claude process exits. */
export async function startAgentProcess(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
  prompt: string,
  onAgentExited?: () => void,
): Promise<void> {
  if (!agent.containerName) {
    throw new Error(`Agent ${agent.issueId} has no container name`);
  }

  const cfg = store.getProjectConfig(projectPath);
  const driver = resolveDriver(agent, projectPath);
  const providerInstance = resolveProviderInstance(agent, cfg);

  // Kill any running agent process before starting new one
  await killProcesses(agent.containerName, driver.processPattern);

  clearLiveOutput(agent.issueId);
  const launchCmd = driver.buildLaunchCommand(prompt);
  const envVars = [
    ...driver.buildEnvVars(cfg, providerInstance?.config),
    `LINEAR_API_KEY=${resolveTrackerConfig(projectPath, "linear")?.apiKey || ""}`,
    `LINEAR_ISSUE_ID=${agent.linearIssueUuid || ""}`,
    `ISSUE_ID=${agent.issueId}`,
  ];
  const { execId } = await execInContainerAsync(agent.containerName, [
    "sh", "-c",
    launchCmd,
  ], {
    user: "root",
    workingDir: "/workspace",
    env: envVars,
    onData: (chunk) => appendLiveOutput(agent.issueId, chunk),
    onExit: async (exitCode, output) => {
      if (activeExecIds.get(agent.issueId) !== execId) {
        console.log(`[agent-aggregate] Ignoring stale onExit for ${agent.issueId} (exec ${execId.slice(0, 8)})`);
        return;
      }
      console.log(`[agent-aggregate] Agent exited for ${agent.issueId} with code ${exitCode}, output length: ${output?.length || 0}`);

      const agentResponse = driver.filterOutput(output?.trim() || "");
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

      // Notify aggregate via injected callback (preferred path)
      if (onAgentExited) {
        store.appendLog(projectPath, `agent-${agent.issueId}-lifecycle`, `claude exited code=${exitCode}`);
        onAgentExited();
      } else {
        // Fallback: direct state update (legacy path)
        const currentAgent = store.getAgent(projectPath, agent.issueId);
        if (currentAgent && currentAgent.state?.agent === "running") {
          currentAgent.state.agent = "stopped";
          store.saveAgent(projectPath, agent.issueId, currentAgent);
          store.appendLog(projectPath, `agent-${agent.issueId}-lifecycle`, `claude exited code=${exitCode}`);
          eventBus.emit("agent:exited", { agentId: agent.issueId, issueId: agent.issueId });
        }
      }
    },
  });
  activeExecIds.set(agent.issueId, execId);

  state.agent = "running";
}

/** Stop agent process (container stays alive). */
export async function stopAgentProcess(
  agent: store.AgentData,
  state: AgentState,
  projectPath?: string,
): Promise<void> {
  if (agent.containerName) {
    const driver = resolveDriver(agent, projectPath);
    await killProcesses(agent.containerName, driver.processPattern);
  }
  state.agent = "stopped";
}
