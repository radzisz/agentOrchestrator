// ---------------------------------------------------------------------------
// Issue Tracker registry — returns active trackers per project
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import type { IssueTracker, TrackerTypeSchema } from "./types";
import { linearTracker } from "./linear-tracker";
import { sentryTracker } from "./sentry-tracker";

const ALL_TRACKERS: IssueTracker[] = [linearTracker, sentryTracker];

/** Get all registered trackers. */
export function getAllTrackers(): IssueTracker[] {
  return ALL_TRACKERS;
}

/** Get a tracker by name. */
export function getTracker(name: string): IssueTracker | undefined {
  return ALL_TRACKERS.find((t) => t.name === name);
}

/** Get schemas for all available tracker types. */
export function getAvailableTrackerTypes(): TrackerTypeSchema[] {
  return ALL_TRACKERS.map((t) => t.schema);
}

/**
 * Get the shortest poll interval across all tracker instances.
 * Falls back to 60s if no instances have a pollInterval configured.
 */
export function getTrackerPollInterval(): number {
  const instances = store.getTrackerInstances();
  let min = 60000;
  for (const inst of instances) {
    const val = parseInt(inst.config.pollInterval);
    if (!isNaN(val) && val > 0 && val < min) min = val;
  }
  return min;
}

/**
 * Resolve the effective config for a tracker entry.
 * Merges instance config + entry overrides.
 * Can be called with just (projectPath, type) for simple lookups,
 * or with explicit entry for multi-entry-per-type support.
 */
export function resolveTrackerConfig(
  projectPath: string,
  type: string,
  instanceId?: string,
  overrides?: Record<string, string>,
): Record<string, string> | null {
  // Find instance
  const instance = instanceId
    ? store.getTrackerInstance(instanceId)
    : store.getDefaultTrackerInstance(type);

  if (!instance) return null;

  // Start with instance config
  const resolved = { ...instance.config };

  // If overrides passed directly, use them
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined && v !== "") resolved[k] = v;
    }
    return resolved;
  }

  // Look up overrides from TRACKER_CONFIG
  const trackerConfig = store.getProjectTrackerConfig(projectPath);
  if (trackerConfig) {
    const entry = trackerConfig.trackers.find((t) => t.type === type);
    if (entry?.overrides) {
      for (const [k, v] of Object.entries(entry.overrides)) {
        if (v === "~") { delete resolved[k]; continue; } // sentinel = explicitly cleared
        if (v !== undefined && v !== "") resolved[k] = v;
      }
    }
  }

  return resolved;
}

/**
 * Get trackers that are configured and active for a given project.
 * Reads TRACKER_CONFIG from project, resolves instances, returns bound trackers.
 */
export function getActiveTrackers(projectPath: string): IssueTracker[] {
  const trackerConfig = store.getProjectTrackerConfig(projectPath);
  if (!trackerConfig) return [];
  return getTrackersFromConfig(projectPath, trackerConfig);
}

/** Resolve trackers from TRACKER_CONFIG */
function getTrackersFromConfig(projectPath: string, trackerConfig: store.ProjectTrackerConfig): IssueTracker[] {
  const active: IssueTracker[] = [];

  for (const entry of trackerConfig.trackers) {
    if (!entry.enabled) continue;

    const tracker = getTracker(entry.type);
    if (!tracker) continue;

    const resolved = resolveTrackerConfig(projectPath, entry.type, entry.instanceId, entry.overrides);
    if (!resolved) continue;

    // Check that required fields are present
    const requiredFields = tracker.schema.fields.filter((f) => f.required);
    const hasAllRequired = requiredFields.every((f) => resolved[f.key]);
    if (!hasAllRequired) continue;

    active.push(tracker);
  }

  return active;
}

