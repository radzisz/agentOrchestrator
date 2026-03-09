// ---------------------------------------------------------------------------
// Runtime reconciliation — shared logic for detecting and fixing stale state
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";

/**
 * Reconcile a LOCAL runtime whose container is dead.
 * Marks it as STOPPED and clears servicesEnabled.
 * Returns list of changes made, or empty array if nothing changed.
 */
export function reconcileDeadRuntime(
  projectPath: string,
  runtime: store.RuntimeData,
): string[] {
  const changes: string[] = [];
  let dirty = false;

  if (runtime.status === "RUNNING" || runtime.status === "STARTING") {
    runtime.status = "STOPPED";
    dirty = true;
    changes.push(`Runtime ${runtime.branch} was ${runtime.status} → STOPPED`);
  }

  if (runtime.servicesEnabled) {
    runtime.servicesEnabled = false;
    dirty = true;
  }

  if (dirty) {
    runtime.updatedAt = new Date().toISOString();
    store.saveRuntime(projectPath, runtime.branch, runtime.type, runtime);
  }

  return changes;
}

/**
 * Reconcile all LOCAL runtimes for a project against running containers.
 * Fixes stale RUNNING/STARTING states when containers are dead.
 */
export function reconcileAllRuntimes(
  projectPath: string,
  runtimes: store.RuntimeData[],
  runningContainers: Set<string>,
): string[] {
  const allChanges: string[] = [];

  for (const rt of runtimes) {
    if (rt.type !== "LOCAL") continue;
    if (!rt.containerName || rt.mode === "host") continue;

    const alive = runningContainers.has(rt.containerName);
    if (!alive) {
      const changes = reconcileDeadRuntime(projectPath, rt);
      allChanges.push(...changes);
    }
  }

  return allChanges;
}
