/**
 * In-memory IM configuration aggregate.
 *
 * Loaded once at startup, updated from UI via API, persisted to store.
 * Telegram integration reads this directly — no disk/store scanning on each send.
 */

import type { IMProviderInstance } from "@/lib/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectIMSettings {
  enabled: boolean;        // per-project IM on/off
  instanceId: string | null; // project-specific instance override (null = use default)
}

interface IMConfigState {
  instances: IMProviderInstance[];
  /** projectName → settings */
  projects: Map<string, ProjectIMSettings>;
}

// ---------------------------------------------------------------------------
// Singleton (survives HMR via globalThis)
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __imConfig?: IMConfigState };

function state(): IMConfigState {
  if (!g.__imConfig) {
    g.__imConfig = { instances: [], projects: new Map() };
  }
  return g.__imConfig;
}

// ---------------------------------------------------------------------------
// Bootstrap — called once from instrumentation
// ---------------------------------------------------------------------------

export function loadIMConfig(): void {
  // Dynamic import to avoid circular deps at module level
  const store = require("@/lib/store") as typeof import("@/lib/store");
  const s = state();

  // Load instances
  s.instances = store.getIMProviderInstances();

  // Load per-project settings
  s.projects.clear();
  for (const p of store.listProjects()) {
    const cfg = store.getProjectConfig(p.path);
    s.projects.set(p.name, {
      enabled: cfg.IM_ENABLED !== "false",
      instanceId: cfg.IM_PROVIDER_INSTANCE_ID || null,
    });
  }

  console.log(`[im-config] Loaded ${s.instances.length} instances, ${s.projects.size} projects`);
}

// ---------------------------------------------------------------------------
// Reads (used by telegram integration — fast, in-memory)
// ---------------------------------------------------------------------------

/** Resolve credentials for a given issue. Returns null if disabled or not configured. */
export function resolveCredentials(issueId: string, projectName?: string): { token: string; chatId: string } | null {
  const s = state();

  // 1. Find project name from issueId if not provided
  let pName = projectName;
  if (!pName) {
    try {
      const store = require("@/lib/store") as typeof import("@/lib/store");
      for (const p of store.listProjects()) {
        if (store.getAgent(p.path, issueId)) {
          pName = p.name;
          break;
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Check project-level enabled
  if (pName) {
    const ps = s.projects.get(pName);
    if (ps && !ps.enabled) return null;

    // Project-specific instance?
    if (ps?.instanceId) {
      const inst = s.instances.find((i) => i.id === ps.instanceId);
      if (inst) {
        if (!inst.enabled) return null;
        if (inst.config.botToken && inst.config.chatId) {
          return { token: inst.config.botToken, chatId: inst.config.chatId };
        }
      }
    }
  }

  // 3. Fall back to default instance
  const def = s.instances.find((i) => i.isDefault) || s.instances[0];
  if (!def) return null;
  if (!def.enabled) return null;
  if (!def.config.botToken || !def.config.chatId) return null;
  return { token: def.config.botToken, chatId: def.config.chatId };
}

// ---------------------------------------------------------------------------
// Writes (called from API routes — update memory + persist)
// ---------------------------------------------------------------------------

export function updateInstance(instance: IMProviderInstance): void {
  const s = state();
  const idx = s.instances.findIndex((i) => i.id === instance.id);
  if (idx >= 0) {
    s.instances[idx] = instance;
  } else {
    s.instances.push(instance);
  }
}

export function removeInstance(id: string): void {
  const s = state();
  s.instances = s.instances.filter((i) => i.id !== id);
}

export function reloadInstances(): void {
  try {
    const store = require("@/lib/store") as typeof import("@/lib/store");
    state().instances = store.getIMProviderInstances();
  } catch { /* ignore */ }
}

export function setProjectIMSettings(projectName: string, settings: Partial<ProjectIMSettings>): void {
  const s = state();
  const existing = s.projects.get(projectName) || { enabled: true, instanceId: null };
  s.projects.set(projectName, { ...existing, ...settings });
}

export function getProjectIMSettings(projectName: string): ProjectIMSettings {
  return state().projects.get(projectName) || { enabled: true, instanceId: null };
}
