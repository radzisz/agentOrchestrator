import { existsSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import { notFound } from "next/navigation";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";
import { ProjectTabs } from "./project-tabs";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return { title: `10xDev: ${name}` };
}

/** Build rtenvConfig from legacy per-project Supabase/Netlify fields */
function buildLegacyRtenvConfig(cfg: Record<string, string>): Record<string, { enabled: boolean; instanceId?: string; projectConfig: Record<string, string> }> {
  const result: Record<string, { enabled: boolean; instanceId?: string; projectConfig: Record<string, string> }> = {};
  if (cfg.SUPABASE_PROJECT_REF) {
    result.supabase = { enabled: true, projectConfig: { projectRef: cfg.SUPABASE_PROJECT_REF } };
  }
  const netlifySites = cfg.NETLIFY_SITES ? JSON.parse(cfg.NETLIFY_SITES) : [];
  if (netlifySites.length > 0) {
    result.netlify = { enabled: true, projectConfig: { sites: cfg.NETLIFY_SITES } };
  }
  return result;
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) notFound();

  const cfg = store.getProjectConfig(project.path);
  const agents = store.listAgents(project.path);

  const runtimeModes = store.getProjectJsonField<{ local: boolean; remote: boolean }>(project.path, "RUNTIME_MODES") || { local: true, remote: false };
  const runtimeConfig = store.getProjectJsonField(project.path, "RUNTIME_CONFIG");
  const rtenvConfig = store.getProjectJsonField<Record<string, { enabled: boolean; instanceId?: string; projectConfig: Record<string, string> }>>(project.path, "RTENV_CONFIG") || buildLegacyRtenvConfig(cfg);

  // Resolve tracker config for Linear (used by LocalBranchesPanel and preview label)
  const linearConfig = resolveTrackerConfig(project.path, "linear");
  const trackerConfigured = !!linearConfig?.apiKey;
  const trackerTeamKey = linearConfig?.teamKey || null;
  const trackerLabel = linearConfig?.label || "agent";
  const trackerPreviewLabel = linearConfig?.previewLabel || "";

  return (
    <ProjectTabs
      project={{
        name: project.name,
        repoPath: project.path,
        repoUrl: cfg.REPO_URL || null,
        hasGit: existsSync(join(project.path, ".git")),
        trackerConfigured,
        trackerTeamKey,
        trackerLabel,
        trackerPreviewLabel,
        repoProviderInstanceId: cfg.REPO_PROVIDER_INSTANCE_ID || null,
        rtenvConfig,
        runtimeConfig: runtimeConfig as any,
        runtimeModes,
        aiProviderInstanceId: cfg.AI_PROVIDER_INSTANCE_ID || null,
        imProviderInstanceId: cfg.IM_PROVIDER_INSTANCE_ID || null,
        imEnabled: cfg.IM_ENABLED !== "false",
        gitWorkMode: cfg.GIT_WORK_MODE || null,
        aiRules: cfg.AI_RULES ? (() => { try { const p = JSON.parse(cfg.AI_RULES); return Array.isArray(p) ? p : null; } catch { return null; } })() : null,
      }}
      agents={agents.map((a) => ({
        ...a,
        projectName: project.name,
      }))}
    />
  );
}
