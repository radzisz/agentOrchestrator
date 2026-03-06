import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const cfg = store.getProjectConfig(project.path);
  const agents = store.listAgents(project.path);
  const runtimes = store.listRuntimes(project.path);

  return NextResponse.json({
    name: project.name,
    path: project.path,
    config: cfg,
    agents,
    runtimes,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = await req.json();
  const cfg = store.getProjectConfig(project.path);

  // Map old field names to config keys
  const fieldMap: Record<string, string> = {
    linearApiKey: "LINEAR_API_KEY",
    linearTeamKey: "LINEAR_TEAM_KEY",
    linearTeamId: "LINEAR_TEAM_ID",
    linearLabel: "LINEAR_LABEL",
    githubToken: "GITHUB_TOKEN",
    repoUrl: "REPO_URL",
    supabaseAccessToken: "SUPABASE_ACCESS_TOKEN",
    supabaseProjectRef: "SUPABASE_PROJECT_REF",
    netlifyAuthToken: "NETLIFY_AUTH_TOKEN",
  };

  for (const [bodyKey, envKey] of Object.entries(fieldMap)) {
    if (bodyKey in body) {
      const val = body[bodyKey];
      if (val === null || val === undefined || val === "") {
        delete cfg[envKey];
      } else {
        cfg[envKey] = String(val);
      }
    }
  }

  // JSON fields
  const jsonFieldMap: Record<string, string> = {
    netlifySites: "NETLIFY_SITES",
    sentryProjects: "SENTRY_PROJECTS",
    runtimeConfig: "RUNTIME_CONFIG",
    runtimeModes: "RUNTIME_MODES",
  };

  for (const [bodyKey, envKey] of Object.entries(jsonFieldMap)) {
    if (bodyKey in body) {
      const val = body[bodyKey];
      if (val === null || val === undefined) {
        delete cfg[envKey];
      } else {
        cfg[envKey] = JSON.stringify(val);
      }
    }
  }

  // Update project path if name changed
  if (body.repoPath && body.repoPath !== project.path) {
    store.addProject({ name: project.name, path: body.repoPath });
  }

  store.saveProjectConfig(project.path, cfg);

  return NextResponse.json({ name: project.name, path: project.path, config: cfg });
}
