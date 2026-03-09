import * as store from "@/lib/store";

export interface ResolvedRtenv {
  supabase?: { accessToken: string; projectRef: string };
  netlify?: { authToken: string; sites: Array<{ name: string; siteName: string }> };
  vercel?: { authToken: string; teamId?: string; projects: Array<{ name: string; projectName: string; domain?: string }> };
}

/**
 * Resolve runtime environment config for a project.
 * Reads from RTENV_CONFIG (new) and falls back to legacy per-project fields.
 */
export function resolveRtenvConfig(projectPath: string): ResolvedRtenv {
  const cfg = store.getProjectConfig(projectPath);
  const rtenvConfig = store.getProjectJsonField<Record<string, {
    enabled: boolean;
    instanceId?: string;
    projectConfig: Record<string, string>;
  }>>(projectPath, "RTENV_CONFIG");

  const result: ResolvedRtenv = {};

  if (rtenvConfig) {
    // New-style: resolve from RTENV_CONFIG + global instances
    const sb = rtenvConfig.supabase;
    if (sb?.enabled) {
      const inst = resolveInstance("supabase", sb.instanceId);
      if (inst && sb.projectConfig.projectRef) {
        result.supabase = {
          accessToken: inst.config.accessToken,
          projectRef: sb.projectConfig.projectRef,
        };
      }
    }

    const nl = rtenvConfig.netlify;
    if (nl?.enabled) {
      const inst = resolveInstance("netlify", nl.instanceId);
      if (inst && nl.projectConfig.sites) {
        try {
          const sites = JSON.parse(nl.projectConfig.sites);
          result.netlify = {
            authToken: inst.config.authToken,
            sites,
          };
        } catch {}
      }
    }

    const vc = rtenvConfig.vercel;
    if (vc?.enabled) {
      const inst = resolveInstance("vercel", vc.instanceId);
      if (inst && vc.projectConfig.projects) {
        try {
          const projects = JSON.parse(vc.projectConfig.projects);
          result.vercel = {
            authToken: inst.config.authToken,
            teamId: inst.config.teamId || undefined,
            projects,
          };
        } catch {}
      }
    }
  } else {
    // Legacy fallback: read from per-project config fields
    if (cfg.SUPABASE_ACCESS_TOKEN && cfg.SUPABASE_PROJECT_REF) {
      result.supabase = {
        accessToken: cfg.SUPABASE_ACCESS_TOKEN,
        projectRef: cfg.SUPABASE_PROJECT_REF,
      };
    }

    const netlifySites = store.getProjectJsonField<Array<{ name: string; siteName: string }>>(projectPath, "NETLIFY_SITES") || [];
    if (cfg.NETLIFY_AUTH_TOKEN && netlifySites.length > 0) {
      result.netlify = {
        authToken: cfg.NETLIFY_AUTH_TOKEN,
        sites: netlifySites,
      };
    }
  }

  return result;
}

function resolveInstance(type: string, instanceId?: string): store.RuntimeEnvInstance | undefined {
  if (instanceId) {
    return store.getRtenvInstance(instanceId);
  }
  // Use first enabled instance of this type
  const instances = store.getRtenvInstancesByType(type);
  return instances.find((i) => i.enabled);
}
