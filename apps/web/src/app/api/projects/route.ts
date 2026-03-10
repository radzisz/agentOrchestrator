import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import { getBasePath } from "@/integrations/local-drive";

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

export function discoverGitRemoteUrl(projectPath: string): string | null {
  try {
    if (!existsSync(join(projectPath, ".git"))) return null;
    const url = execSync("git config --get remote.origin.url", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!url) return null;
    if (url.startsWith("git@")) {
      return url.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
    }
    return url.replace(/\.git$/, "");
  } catch {
    return null;
  }
}

/**
 * Ensure the project directory has a git repository.
 * If the directory exists but has no .git:
 *  1. runs `git init`
 *  2. adds .gitignore with orchestrator dirs
 *  3. creates an initial commit (empty repo can't be cloned/worktree'd)
 * Returns true if git was freshly initialized.
 */
export function ensureGitRepo(repoPath: string): boolean {
  if (!existsSync(repoPath)) return false;
  if (existsSync(join(repoPath, ".git"))) return false;
  try {
    const opts = { cwd: repoPath, timeout: 5000, stdio: "pipe" as const };
    execSync("git init", opts);

    // Ensure .gitignore excludes orchestrator files
    const gitignorePath = join(repoPath, ".gitignore");
    const ignoreEntries = [".10timesdev/", ".env.10timesdev"];
    if (existsSync(gitignorePath)) {
      const existing = readFileSync(gitignorePath, "utf-8");
      const missing = ignoreEntries.filter((e) => !existing.includes(e));
      if (missing.length) {
        appendFileSync(gitignorePath, "\n" + missing.join("\n") + "\n");
      }
    } else {
      writeFileSync(gitignorePath, ignoreEntries.join("\n") + "\n");
    }

    // Initial commit so clone/worktree works
    execSync("git add -A", opts);
    execSync('git commit -m "Initial commit"', opts);
    return true;
  } catch {
    return false;
  }
}

export interface CreateProjectInput {
  name: string;
  repoPath?: string;
  repoUrl?: string;
  supabaseAccessToken?: string;
  supabaseProjectRef?: string;
  netlifyAuthToken?: string;
  netlifySites?: Array<{ name: string; siteName: string }>;
}

export interface CreateProjectResult {
  name: string;
  path: string;
  gitInitialized: boolean;
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  // Resolve path
  let repoPath = input.repoPath;
  if (!repoPath && input.repoUrl) {
    const basePath = await getBasePath();
    repoPath = `${basePath}/${input.name}`;
  }
  if (!repoPath) throw new Error("Either repoPath or repoUrl is required");

  // Register project
  store.addProject({ name: input.name, path: repoPath });

  // Initialize git if missing
  const gitInitialized = ensureGitRepo(repoPath);

  // Build and save config
  const envConfig: store.ProjectConfig = {};
  if (input.repoUrl) envConfig.REPO_URL = input.repoUrl;
  if (input.supabaseAccessToken) envConfig.SUPABASE_ACCESS_TOKEN = input.supabaseAccessToken;
  if (input.supabaseProjectRef) envConfig.SUPABASE_PROJECT_REF = input.supabaseProjectRef;
  if (input.netlifyAuthToken) envConfig.NETLIFY_AUTH_TOKEN = input.netlifyAuthToken;
  if (input.netlifySites) envConfig.NETLIFY_SITES = JSON.stringify(input.netlifySites);
  store.saveProjectConfig(repoPath, envConfig);

  return { name: input.name, path: repoPath, gitInitialized };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

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
    };
  });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (!body.name) {
    return NextResponse.json({ error: "Project name is required" }, { status: 400 });
  }

  const result = await createProject(body);
  return NextResponse.json(result, { status: 201 });
}
