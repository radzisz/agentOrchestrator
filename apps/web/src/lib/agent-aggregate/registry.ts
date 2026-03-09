// ---------------------------------------------------------------------------
// Aggregate registry — singleton Map<key, AgentAggregate>
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import { AgentAggregate } from "./aggregate";

const aggregates = new Map<string, AgentAggregate>();

function key(projectName: string, issueId: string): string {
  return `${projectName}:${issueId}`;
}

/**
 * Get or create an AgentAggregate for the given agent.
 * Lazy-loaded: first access creates aggregate from store.getAgent() data.
 */
export function getAggregate(projectName: string, issueId: string): AgentAggregate {
  const k = key(projectName, issueId);
  const existing = aggregates.get(k);
  if (existing) {
    existing.reload();
    return existing;
  }

  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const agent = store.getAgentRef(project.path, issueId);
  if (!agent) throw new Error(`Agent not found: ${issueId}`);

  const agg = new AgentAggregate(projectName, project.path, agent);
  aggregates.set(k, agg);
  return agg;
}

/**
 * Get aggregate if it exists (no auto-create).
 * Returns null if agent doesn't exist yet.
 */
export function tryGetAggregate(projectName: string, issueId: string): AgentAggregate | null {
  const k = key(projectName, issueId);
  const existing = aggregates.get(k);
  if (existing) {
    existing.reload();
    return existing;
  }

  const project = store.getProjectByName(projectName);
  if (!project) return null;

  const agent = store.getAgentRef(project.path, issueId);
  if (!agent) return null;

  const agg = new AgentAggregate(projectName, project.path, agent);
  aggregates.set(k, agg);
  return agg;
}

/**
 * Create an aggregate for a new agent (before store.saveAgent has been called).
 * Used during spawn when the agent record doesn't exist yet.
 * Returns existing aggregate if one is already registered (prevents duplicate spawns).
 */
export function createAggregate(
  projectName: string,
  projectPath: string,
  agent: store.AgentData,
): AgentAggregate {
  const k = key(projectName, agent.issueId);
  const existing = aggregates.get(k);
  if (existing) return existing;
  const agg = new AgentAggregate(projectName, projectPath, agent);
  aggregates.set(k, agg);
  return agg;
}

/** Remove aggregate from registry (after agent cleanup). */
export function removeAggregate(projectName: string, issueId: string): void {
  aggregates.delete(key(projectName, issueId));
}

/** Clear all aggregates (for testing or cache invalidation). */
export function clearAggregates(): void {
  aggregates.clear();
}
