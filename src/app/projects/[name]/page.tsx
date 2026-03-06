import * as store from "@/lib/store";
import { notFound } from "next/navigation";
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
  const sentryProjects = store.getProjectJsonField<string[]>(project.path, "SENTRY_PROJECTS") || [];

  return (
    <ProjectTabs
      project={{
        name: project.name,
        repoPath: project.path,
        repoUrl: cfg.REPO_URL || null,
        linearApiKey: cfg.LINEAR_API_KEY || null,
        linearTeamKey: cfg.LINEAR_TEAM_KEY || null,
        linearLabel: cfg.LINEAR_LABEL || "agent",
        linearPreviewLabel: cfg.LINEAR_PREVIEW_LABEL || "",
        linearAssigneeId: cfg.LINEAR_ASSIGNEE_ID || null,
        linearAssigneeName: cfg.LINEAR_ASSIGNEE_NAME || null,
        githubToken: cfg.GITHUB_TOKEN || null,
        supabaseAccessToken: cfg.SUPABASE_ACCESS_TOKEN || null,
        supabaseProjectRef: cfg.SUPABASE_PROJECT_REF || null,
        netlifyAuthToken: cfg.NETLIFY_AUTH_TOKEN || null,
        netlifySites,
        sentryProjects,
        runtimeConfig: runtimeConfig as any,
        runtimeModes,
      }}
      agents={agents.map((a) => ({
        ...a,
        projectName: project.name,
      }))}
    />
  );
}
