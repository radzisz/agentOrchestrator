// ---------------------------------------------------------------------------
// Container operations — extracted from agent-lifecycle.ts
// All Docker calls use CLI (child_process) — never blocks event loop.
// ---------------------------------------------------------------------------

import * as cmd from "@/lib/cmd";
import * as store from "@/lib/store";
import {
  DOCKER_IMAGE,
  ensureImage,
  removeContainer,
  removeVolume,
  createAndStartContainer,
  execInContainerSimple,
} from "@/lib/docker";
import { getProjectRuntimeConfig, detectPort } from "@/services/runtime";
import type { AgentState } from "../types";

/**
 * Build Docker port bindings: host allocated ports → container native service ports.
 */
function buildPortBindings(
  ports: store.PortInfo,
  projectPath: string,
): { portBindings: Record<string, Array<{ HostPort: string }>>; exposedPorts: Record<string, object> } {
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  const exposedPorts: Record<string, object> = {};

  try {
    const rtCfg = getProjectRuntimeConfig(projectPath);
    if (rtCfg.services.length > 0) {
      const services = rtCfg.services.map((s, i) => ({
        ...s,
        port: s.port || detectPort(s.cmd, i),
      }));
      for (let i = 0; i < services.length && i < ports.all.length; i++) {
        const nativePort = services[i].port;
        const allocatedPort = ports.all[i];
        portBindings[`${nativePort}/tcp`] = [{ HostPort: `${allocatedPort}` }];
        exposedPorts[`${nativePort}/tcp`] = {};
      }
      return { portBindings, exposedPorts };
    }
  } catch {
    // fallback to identity mapping
  }

  for (const port of ports.all) {
    portBindings[`${port}/tcp`] = [{ HostPort: `${port}` }];
    exposedPorts[`${port}/tcp`] = {};
  }
  return { portBindings, exposedPorts };
}

/** Check container status and update state accordingly.
 *  Uses cmd.run (child_process) — never blocks event loop. */
export async function checkContainer(
  agent: store.AgentData,
  state: AgentState,
): Promise<void> {
  if (!agent.containerName) {
    state.container = "missing";
    return;
  }
  const r = await cmd.run(
    `docker inspect --format "{{.State.Status}}" "${agent.containerName}"`,
    { source: "checkContainer", timeout: 10_000 },
  );
  if (!r.ok) {
    state.container = "missing";
  } else if (r.stdout.trim() === "running") {
    state.container = "running";
  } else {
    state.container = "stopped";
  }
}

/** Create and start a Docker container for the agent. Recreates if one exists. */
export async function createContainer(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
): Promise<void> {
  if (!agent.containerName || !agent.agentDir) {
    throw new Error(`Agent ${agent.issueId} has no container name or directory`);
  }

  await removeContainer(agent.containerName);
  await ensureImage();

  const cfg = store.getProjectConfig(projectPath);
  const ports = agent.portSlot !== undefined ? store.getPortsForSlot(agent.portSlot) : null;

  let portBindings: Record<string, Array<{ HostPort: string }>> = {};
  if (ports) {
    ({ portBindings } = buildPortBindings(ports, projectPath));
  }

  await createAndStartContainer({
    image: DOCKER_IMAGE,
    name: agent.containerName,
    env: [
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
      `LINEAR_API_KEY=${cfg.LINEAR_API_KEY || ""}`,
      `LINEAR_ISSUE_ID=${agent.linearIssueUuid || ""}`,
      `ISSUE_ID=${agent.issueId}`,
    ],
    binds: [
      `${agent.agentDir}:/workspace`,
      "claude-auth:/home/agent/.claude",
      `agent-node-modules-${agent.issueId}:/workspace/node_modules`,
    ],
    portBindings,
  });

  // Fix .git ownership so agent user can write to objects/refs/etc.
  // On Windows bind mounts, files appear as root inside the container.
  await execInContainerSimple(
    agent.containerName,
    "chown -R agent:agent /workspace/.git",
    { user: "root" },
  ).catch(() => {}); // best effort

  state.container = "running";
}

/** Ensure container is alive, recreate if dead. */
export async function ensureContainerRunning(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
): Promise<void> {
  await checkContainer(agent, state);
  if (state.container === "running") return;

  console.log(`[agent-aggregate] Container ${agent.containerName} not running, recreating...`);
  await createContainer(agent, projectPath, state);
}

/** Remove the agent's container and node_modules volume. */
export async function removeContainerAndVolume(
  agent: store.AgentData,
  state: AgentState,
): Promise<void> {
  if (agent.containerName) {
    await removeContainer(agent.containerName);
  }
  try {
    await removeVolume(`agent-node-modules-${agent.issueId}`);
  } catch {
    // best effort
  }
  state.container = "missing";
}
