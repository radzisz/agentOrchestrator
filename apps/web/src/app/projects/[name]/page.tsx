import * as store from "@/lib/store";
import { notFound } from "next/navigation";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";
import { ProjectTabs } from "./project-tabs";

export const dynamic = "force-dynamic";

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
  const netlifySites = store.getProjectJsonField<Array<{ name: string; siteName: string }>>(project.path, "NETLIFY_SITES") || [];

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
        trackerConfigured,
        trackerTeamKey,
        trackerLabel,
        trackerPreviewLabel,
        repoProviderInstanceId: cfg.REPO_PROVIDER_INSTANCE_ID || null,
        supabaseAccessToken: cfg.SUPABASE_ACCESS_TOKEN || null,
        supabaseProjectRef: cfg.SUPABASE_PROJECT_REF || null,
        netlifyAuthToken: cfg.NETLIFY_AUTH_TOKEN || null,
        netlifySites,
        runtimeConfig: runtimeConfig as any,
        runtimeModes,
        aiProviderInstanceId: cfg.AI_PROVIDER_INSTANCE_ID || null,
        imProviderInstanceId: cfg.IM_PROVIDER_INSTANCE_ID || null,
      }}
      agents={agents.map((a) => ({
        ...a,
        projectName: project.name,
      }))}
    />
  );
}
