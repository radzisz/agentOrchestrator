import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { githubApi as github } from "@orchestrator/scm-github";

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
  const githubToken = cfg.GITHUB_TOKEN;
  const repoUrl = cfg.REPO_URL;

  if (!githubToken || !repoUrl) {
    return NextResponse.json(
      { error: "GitHub token or repo URL not configured" },
      { status: 400 }
    );
  }

  const parsed = github.parseRepoUrl(repoUrl);
  if (!parsed) {
    return NextResponse.json(
      { error: `Cannot parse repo URL: ${repoUrl}` },
      { status: 400 }
    );
  }

  const mainBranch = await github.getDefaultBranch(githubToken, parsed.owner, parsed.repo);
  const branches = await github.listBranches(githubToken, parsed.owner, parsed.repo, mainBranch);

  // Enrich with agent info
  const agents = store.listAgents(project.path);
  const agentByIssue = new Map(agents.map((a) => [a.issueId, a]));

  // Enrich with runtime info
  const runtimes = store.listRuntimes(project.path);
  const runtimesByBranch = new Map<string, typeof runtimes>();
  for (const rt of runtimes) {
    const list = runtimesByBranch.get(rt.branch) || [];
    list.push(rt);
    runtimesByBranch.set(rt.branch, list);
  }

  const netlifySites = store.getProjectJsonField<Array<{ name: string; siteName: string }>>(project.path, "NETLIFY_SITES") || [];
  const runtimeModes = store.getProjectJsonField<{ local: boolean; remote: boolean }>(project.path, "RUNTIME_MODES") || { local: true, remote: false };

  const enriched = branches.map((b) => {
    const issueMatch = b.name.match(/agent\/([A-Z]+-\d+)/);
    const issueId = issueMatch ? issueMatch[1] : null;
    const agent = issueId ? agentByIssue.get(issueId) : null;
    const branchRuntimes = runtimesByBranch.get(b.name) || [];
    const safeBranch = (branch: string) => branch.replace(/[^a-zA-Z0-9_-]/g, "-");
    const withId = (rt: typeof runtimes[number] | null) =>
      rt ? { ...rt, id: `${rt.type}/${safeBranch(rt.branch)}` } : null;

    const localRuntime = withId(branchRuntimes.find((r) => r.type === "LOCAL") ?? null);
    const remoteRuntime = withId(branchRuntimes.find((r) => r.type === "REMOTE") ?? null);

    return {
      ...b,
      issueId,
      agentId: issueId ?? null,
      agentStatus: agent?.status ?? null,
      agentUiStatus: agent?.uiStatus ?? null,
      supabaseConfigured: !!(cfg.SUPABASE_ACCESS_TOKEN && cfg.SUPABASE_PROJECT_REF),
      netlifyConfigured: netlifySites.length > 0,
      previewUrls: netlifySites.map((s) => ({
        name: s.name,
        url: `https://${b.name.replace("/", "-").toLowerCase()}--${s.siteName}.netlify.app`,
      })),
      localRuntime,
      remoteRuntime,
      runtimeConfig: store.getProjectJsonField(project.path, "RUNTIME_CONFIG"),
      runtimeModes,
    };
  });

  return NextResponse.json(enriched);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const cfg = store.getProjectConfig(project.path);
  const body = await req.json();
  const { action, branch } = body as { action: string; branch: string };

  if (!branch) {
    return NextResponse.json({ error: "branch is required" }, { status: 400 });
  }

  if (action === "create-pr") {
    const githubToken = cfg.GITHUB_TOKEN;
    const repoUrl = cfg.REPO_URL;
    if (!githubToken || !repoUrl) {
      return NextResponse.json({ error: "GitHub not configured" }, { status: 400 });
    }

    const parsed = github.parseRepoUrl(repoUrl);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid repo URL" }, { status: 400 });
    }

    const mainBranch = await github.getDefaultBranch(githubToken, parsed.owner, parsed.repo);
    const issueMatch = branch.match(/agent\/([A-Z]+-\d+)/);
    const issueId = issueMatch ? issueMatch[1] : null;
    const title = body.title || `${issueId || branch}`;

    const pr = await github.createPullRequest(
      githubToken,
      parsed.owner,
      parsed.repo,
      {
        head: branch,
        base: mainBranch,
        title,
        body: body.body || `Branch: \`${branch}\``,
        draft: body.draft ?? false,
      }
    );

    return NextResponse.json(pr);
  }

  return NextResponse.json(
    { error: "Use POST /api/projects/{name}/runtimes instead" },
    { status: 410 }
  );
}
