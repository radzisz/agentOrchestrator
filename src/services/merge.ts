import { simpleGit } from "@/lib/cmd";
import * as store from "@/lib/store";
import { eventBus } from "@/lib/event-bus";
import * as linear from "./linear";

/**
 * Merge workflow
 */

export interface MergeOptions {
  projectName: string;
  issueId: string;
  toggle?: boolean;
  enableToggle?: boolean;
  closeIssue?: boolean;
}

export interface MergeResult {
  success: boolean;
  commits: string;
  diffStats: string;
}

/** Detect default branch (main or master) from remote HEAD */
async function getDefaultBranch(git: ReturnType<typeof simpleGit>): Promise<string> {
  try {
    const ref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return ref.trim().replace("refs/remotes/origin/", "");
  } catch {
    // Fallback: check which exists
    try {
      await git.raw(["rev-parse", "--verify", "origin/main"]);
      return "main";
    } catch {
      return "master";
    }
  }
}

export async function getMergeInfo(projectName: string, issueId: string): Promise<{
  commits: string;
  diffStats: string;
}> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const agent = store.getAgent(project.path, issueId);
  if (!agent) throw new Error(`Agent not found: ${issueId}`);

  const git = simpleGit(project.path);
  const branchName = `agent/${issueId}`;
  const defaultBranch = await getDefaultBranch(git);

  await git.fetch("origin", branchName);

  const commits = (await git.log({ from: defaultBranch, to: `origin/${branchName}`, "--oneline": null }))
    .all.map(c => `${c.hash.slice(0, 7)} ${c.message}`).join("\n");

  const diffStats = await git.diff(["--stat", `${defaultBranch}..origin/${branchName}`]);

  return { commits, diffStats: diffStats.trim() };
}

export async function merge(options: MergeOptions): Promise<MergeResult> {
  const { projectName, issueId, toggle, enableToggle, closeIssue = true } = options;

  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const agent = store.getAgent(project.path, issueId);
  if (!agent) throw new Error(`Agent not found: ${issueId}`);

  const cfg = store.getProjectConfig(project.path);
  const git = simpleGit(project.path);
  const branchName = `agent/${issueId}`;
  const defaultBranch = await getDefaultBranch(git);

  agent.status = "MERGING";
  store.saveAgent(project.path, issueId, agent);

  // Fetch branch
  await git.fetch("origin", branchName);

  const logResult = await git.log({ from: defaultBranch, to: `origin/${branchName}`, "--oneline": null });
  const commits = logResult.all.map(c => `${c.hash.slice(0, 7)} ${c.message}`).join("\n");

  const diffStats = (await git.diff(["--stat", `${defaultBranch}..origin/${branchName}`])).trim();

  if (!commits) {
    throw new Error("No new commits to merge");
  }

  // Feature toggle
  let toggleMsg = "";
  if (toggle) {
    const toggleName = issueId.toLowerCase().replace("-", "_");

    toggleMsg = enableToggle
      ? ` z toggle **${toggleName}** = ON`
      : ` z toggle **${toggleName}** = OFF (kod w produkcji, ficzer nieaktywny)`;
  }

  // Merge
  const lastCommit = logResult.latest;
  const lastMsg = lastCommit ? lastCommit.message : "";

  await git.merge([`origin/${branchName}`, "--no-ff", "-m", `Merge ${issueId}: ${lastMsg}`]);
  await git.push("origin", defaultBranch);

  // Comment on Linear + optionally set Done (before cleanup)
  if (agent.linearIssueUuid) {
    await linear.addComment(
      cfg.LINEAR_API_KEY,
      agent.linearIssueUuid,
      `✅ Merged to ${defaultBranch}${toggleMsg}`
    );

    if (closeIssue) {
      const doneId = await linear.getWorkflowStateId(
        cfg.LINEAR_API_KEY,
        cfg.LINEAR_TEAM_KEY,
        "Done"
      );
      if (doneId) {
        await linear.updateIssueState(cfg.LINEAR_API_KEY, agent.linearIssueUuid, doneId);
      }
    }
  }

  agent.status = "DONE";
  store.saveAgent(project.path, issueId, agent);

  store.appendLog(project.path, `agent-${issueId}`, `merged commits=${commits} toggle=${toggleMsg || "none"}`);

  eventBus.emit("agent:merged", {
    agentId: issueId,
    issueId,
    branch: branchName,
  });

  return { success: true, commits, diffStats };
}

export async function reject(projectName: string, issueId: string, closeIssue = true): Promise<void> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const agent = store.getAgent(project.path, issueId);
  if (!agent) throw new Error(`Agent not found: ${issueId}`);

  const cfg = store.getProjectConfig(project.path);

  if (agent.linearIssueUuid) {
    await linear.addComment(
      cfg.LINEAR_API_KEY,
      agent.linearIssueUuid,
      "❌ Odrzucone — nie mergowane"
    );

    if (closeIssue) {
      const cancelId = await linear.getWorkflowStateId(
        cfg.LINEAR_API_KEY,
        cfg.LINEAR_TEAM_KEY,
        "Cancelled"
      );
      if (cancelId) {
        await linear.updateIssueState(cfg.LINEAR_API_KEY, agent.linearIssueUuid, cancelId);
      }
    }
  }

  agent.status = "CANCELLED";
  store.saveAgent(project.path, issueId, agent);

  store.appendLog(project.path, `agent-${issueId}`, "rejected");
}

export async function preview(projectName: string, issueId: string): Promise<{
  previewUrl?: string;
  supabaseUrl?: string;
}> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const agent = store.getAgent(project.path, issueId);
  if (!agent) throw new Error(`Agent not found: ${issueId}`);

  const cfg = store.getProjectConfig(project.path);
  const branchName = `agent/${issueId}`;
  const safeBranch = branchName.replace("/", "-");
  let previewUrl: string | undefined;
  let supabaseUrl: string | undefined;

  // Supabase branch
  const supabaseAccessToken = cfg.SUPABASE_ACCESS_TOKEN;
  const supabaseProjectRef = cfg.SUPABASE_PROJECT_REF;

  if (supabaseAccessToken && supabaseProjectRef) {
    try {
      const checkResp = await fetch(
        `https://api.supabase.com/v1/projects/${supabaseProjectRef}/branches`,
        { headers: { Authorization: `Bearer ${supabaseAccessToken}` } }
      );
      const branches = await checkResp.json();
      const existing = branches.find?.((b: any) => b.name === branchName);

      let branchId = existing?.id;
      if (!branchId) {
        const createResp = await fetch(
          `https://api.supabase.com/v1/projects/${supabaseProjectRef}/branches`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${supabaseAccessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ branch_name: branchName }),
          }
        );
        const result = await createResp.json();
        branchId = result.id;
      }

      if (branchId) {
        const statusResp = await fetch(
          `https://api.supabase.com/v1/branches/${branchId}`,
          { headers: { Authorization: `Bearer ${supabaseAccessToken}` } }
        );
        const branchInfo = await statusResp.json();
        supabaseUrl = branchInfo.database?.host;
      }
    } catch (error) {
      console.warn("Supabase preview failed:", error);
    }
  }

  // Netlify preview URLs
  const netlifySites = store.getProjectJsonField<Array<{ name: string; siteName: string }>>(project.path, "NETLIFY_SITES") || [];
  if (netlifySites.length > 0) {
    previewUrl = netlifySites
      .map((s) => `https://${safeBranch}--${s.siteName}.netlify.app`)
      .join(" , ");
  }

  // Comment on Linear
  if (agent.linearIssueUuid) {
    let body = "🔍 Preview ready for review\n\n";
    if (previewUrl) body += `🌐 Preview: ${previewUrl}\n`;
    if (supabaseUrl) body += `🗄️ Supabase: ${supabaseUrl}\n`;
    body += `🌿 Branch: \`${branchName}\`\n\n`;
    body += "Test and reply **OK** or **NO** + what to fix.";

    await linear.addComment(cfg.LINEAR_API_KEY, agent.linearIssueUuid, body);
  }

  eventBus.emit("agent:preview", { agentId: issueId, issueId, previewUrl, supabaseUrl });

  return { previewUrl, supabaseUrl };
}
