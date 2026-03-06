import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { getBasePath } from "@/integrations/local-drive";
import { getDefaultGithubToken } from "@/integrations/github";

export async function GET() {
  const projects = store.listProjects();
  const result = projects.map((p) => {
    const agents = store.listAgents(p.path);
    const activeCount = agents.filter((a) => !["DONE", "CANCELLED"].includes(a.status)).length;
    return {
      name: p.name,
      path: p.path,
      config: p.config,
      _count: { agents: agents.length },
      activeAgentCount: activeCount,
      linearTeamKey: p.config.LINEAR_TEAM_KEY || "",
      linearLabel: p.config.LINEAR_LABEL || "agent",
    };
  });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (!body.name) {
    return NextResponse.json({ error: "Project name is required" }, { status: 400 });
  }

  // If repoPath not given, derive from basePath + name
  let repoPath = body.repoPath;
  if (!repoPath && body.repoUrl) {
    const basePath = await getBasePath();
    repoPath = `${basePath}/${body.name}`;
  }

  // Add project to config.json
  store.addProject({ name: body.name, path: repoPath });

  // Save project config (secrets → .env.10timesdev, rest → .10timesdev/config.json)
  const envConfig: store.ProjectConfig = {};
  if (body.repoUrl) envConfig.REPO_URL = body.repoUrl;
  if (body.linearApiKey) envConfig.LINEAR_API_KEY = body.linearApiKey;
  if (body.linearTeamKey) envConfig.LINEAR_TEAM_KEY = body.linearTeamKey;
  envConfig.LINEAR_LABEL = body.linearLabel || "agent";

  // Use global GitHub token as default if not provided per-project
  let githubToken = body.githubToken;
  if (!githubToken) {
    githubToken = await getDefaultGithubToken();
  }
  if (githubToken) envConfig.GITHUB_TOKEN = githubToken;

  if (body.supabaseAccessToken) envConfig.SUPABASE_ACCESS_TOKEN = body.supabaseAccessToken;
  if (body.supabaseProjectRef) envConfig.SUPABASE_PROJECT_REF = body.supabaseProjectRef;
  if (body.netlifyAuthToken) envConfig.NETLIFY_AUTH_TOKEN = body.netlifyAuthToken;
  if (body.netlifySites) envConfig.NETLIFY_SITES = JSON.stringify(body.netlifySites);

  store.saveProjectConfig(repoPath, envConfig);

  return NextResponse.json({ name: body.name, path: repoPath }, { status: 201 });
}
