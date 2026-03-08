// ---------------------------------------------------------------------------
// Shared helper to find an agent by ID across all projects
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import { getAggregate, tryGetAggregate } from "./registry";
import type { AgentAggregate } from "./aggregate";

/**
 * Find agent by ID. ID can be "projectName/issueId" or just "issueId".
 * Returns the aggregate if found, null otherwise.
 */
export function findAggregate(id: string): AgentAggregate | null {
  if (id.includes("/")) {
    const [projectName, issueId] = id.split("/", 2);
    return tryGetAggregate(projectName, issueId);
  }
  const projects = store.listProjects();
  for (const project of projects) {
    const agent = store.getAgent(project.path, id);
    if (agent) return tryGetAggregate(project.name, id);
  }
  return null;
}

/**
 * Find agent by ID (raw, without aggregate).
 * Returns { projectName, issueId } if found.
 */
export function findAgentInfo(id: string): { projectName: string; issueId: string } | null {
  if (id.includes("/")) {
    const [projectName, issueId] = id.split("/", 2);
    const project = store.getProjectByName(projectName);
    if (!project) return null;
    const agent = store.getAgent(project.path, issueId);
    if (!agent) return null;
    return { projectName, issueId };
  }
  const projects = store.listProjects();
  for (const project of projects) {
    const agent = store.getAgent(project.path, id);
    if (agent) return { projectName: project.name, issueId: id };
  }
  return null;
}
