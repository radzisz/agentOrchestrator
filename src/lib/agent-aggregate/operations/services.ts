// ---------------------------------------------------------------------------
// Service operations — extracted from runtime.ts
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import * as runtime from "@/services/runtime";
import type { AgentState } from "../types";

/** Check services status for an agent. */
export async function checkServices(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
): Promise<void> {
  if (!agent.branch) {
    state.services = {};
    return;
  }
  const rt = store.getRuntime(projectPath, agent.branch, "LOCAL");
  if (!rt) {
    state.services = {};
    return;
  }
  const servicePortMap = rt.servicePortMap || [];
  const services: Record<string, { status: "starting" | "running" | "stopped"; error?: string }> = {};
  for (const svc of servicePortMap) {
    if (rt.status === "RUNNING") {
      services[svc.name] = { status: "running" };
    } else if (rt.status === "STARTING") {
      services[svc.name] = { status: "starting" };
    } else {
      services[svc.name] = { status: "stopped", error: rt.error };
    }
  }
  state.services = services;
}

/** Start all preview services for the agent. */
export async function startAllServices(
  agent: store.AgentData,
  projectName: string,
  projectPath: string,
  state: AgentState,
  opts?: { mode?: "container" | "host" },
): Promise<void> {
  if (!agent.branch) throw new Error("Agent has no branch");

  if (opts?.mode === "host") {
    await runtime.startLocalHost(projectName, agent.branch);
  } else {
    await runtime.startLocal(projectName, agent.branch);
  }

  agent.servicesEnabled = true;
  store.saveAgent(projectPath, agent.issueId, agent);

  // Update state
  await checkServices(agent, projectPath, state);
}

/** Stop all preview services for the agent. */
export async function stopAllServices(
  agent: store.AgentData,
  projectName: string,
  projectPath: string,
  state: AgentState,
): Promise<void> {
  if (!agent.branch) {
    state.services = {};
    return;
  }
  try {
    await runtime.stopRuntime(projectName, agent.branch, "LOCAL");
  } catch {
    // runtime may not exist
  }
  state.services = {};
}
