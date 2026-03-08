// ---------------------------------------------------------------------------
// Git operations — extracted from rebase/route.ts, merge.ts, agent-lifecycle.ts
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { rmSync } from "fs";
import * as cmd from "@/lib/cmd";
import { simpleGit } from "@/lib/cmd";
import * as store from "@/lib/store";
import * as portManager from "@/services/port-manager";
import { eventBus } from "@/lib/event-bus";
import type { AgentState, CurrentOperation } from "../types";

/** Detect default branch (main or master) from remote HEAD */
async function getDefaultBranch(git: ReturnType<typeof simpleGit>): Promise<string> {
  try {
    const ref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return ref.trim().replace("refs/remotes/origin/", "");
  } catch {
    try {
      await git.raw(["rev-parse", "--verify", "origin/main"]);
      return "main";
    } catch {
      return "master";
    }
  }
}

/** Strip tokens/secrets from error messages */
function sanitizeError(err: unknown): string {
  return String(err).replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}

/** Check git status inside agent directory. Returns detected git state. */
export async function checkGit(
  agent: store.AgentData,
  currentGit: Readonly<import("../types").GitState>,
  projectPath?: string,
): Promise<import("../types").GitState> {
  const agentBranch = agent.branch || "";
  // Start with current state (preserves values when we can't check)
  const result: import("../types").GitState = { ...currentGit, branch: agentBranch };

  // Merged is sticky — once true, can't un-merge. Preserve across checks.
  const wasMerged = currentGit.merged;

  const containerName = agent.containerName;

  // Primary: check from host agentDir
  const hasAgentDir = agent.agentDir && existsSync(agent.agentDir);
  const hasAgentRepo = hasAgentDir && existsSync(join(agent.agentDir!, ".git"));

  if (!hasAgentRepo) {
    // If the agent dir itself doesn't exist, clear branch too
    if (!hasAgentDir) {
      result.branch = "";
    }

    // Try container fallback if available
    if (containerName) {
      // Reset before container check — container is the source of truth
      result.dirty = false;
      result.aheadBy = 0;
      result.behindBy = 0;
      result.lastCommit = null;
      result.op = "idle";
      await checkGitInContainer(containerName, result, agentBranch);
    }
    // If no container either, preserve previously persisted git state
  }

  if (hasAgentRepo) {
    const git = simpleGit(agent.agentDir!);

    try {
      const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
      result.branch = branch;

      const statusResult = await git.status();
      const lockFiles = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
      const meaningfulChanges = statusResult.files.filter(f => !lockFiles.has(f.path));
      result.dirty = meaningfulChanges.length > 0;

      let defaultBranch = "main";
      try {
        defaultBranch = await getDefaultBranch(git);
      } catch {}

      try {
        const ahead = await git.raw(["rev-list", "--count", `origin/${defaultBranch}..HEAD`]);
        const behind = await git.raw(["rev-list", "--count", `HEAD..origin/${defaultBranch}`]);
        result.aheadBy = parseInt(ahead.trim()) || 0;
        result.behindBy = parseInt(behind.trim()) || 0;
      } catch {
        result.aheadBy = 0;
        result.behindBy = 0;
      }

      try {
        const mergedBranches = await git.raw(["branch", "-r", "--merged", `origin/${defaultBranch}`]);
        result.merged = mergedBranches.includes(`origin/${agentBranch}`);
      } catch {
        result.merged = false;
      }

      try {
        const log = await git.log({ maxCount: 1 });
        if (log.latest) {
          result.lastCommit = {
            sha: log.latest.hash,
            message: log.latest.message,
            author: log.latest.author_name,
            date: log.latest.date,
          };
        }
      } catch {
        result.lastCommit = null;
      }
    } catch {
      if (containerName) {
        await checkGitInContainer(containerName, result, agentBranch);
      }
    }
  }

  // Check merged from project repo (source of truth).
  if (agentBranch && projectPath && existsSync(join(projectPath, ".git"))) {
    try {
      const projectGit = simpleGit(projectPath);
      const defaultBranch = await getDefaultBranch(projectGit);

      const mergedBranches = await projectGit.raw(["branch", "-r", "--merged", `origin/${defaultBranch}`]);
      if (mergedBranches.includes(`origin/${agentBranch}`)) {
        result.merged = true;
      }

      if (!result.merged) {
        const mergeLog = await projectGit.raw(["log", "--oneline", "--merges", "--grep", `Merge ${agent.issueId}`, `origin/${defaultBranch}`, "-1"]);
        if (mergeLog.trim()) {
          result.merged = true;
        }
      }

      if (result.merged) {
        result.aheadBy = 0;
        result.behindBy = 0;
      }
    } catch {
      // keep whatever the agent repo check found
    }
  }

  // Sticky: once merged, stays merged
  if (wasMerged) result.merged = true;

  return result;
}

/** Check git state by running commands inside the container. Mutates result directly. */
async function checkGitInContainer(
  containerName: string,
  result: import("../types").GitState,
  agentBranch: string,
): Promise<boolean> {
  const timeout = 10_000;
  const src = "checkGit";

  try {
    const test = await cmd.dockerExec(containerName, "git rev-parse --abbrev-ref HEAD", { source: src, timeout: 5000 });
    if (!test.ok) return false;

    result.branch = test.stdout.trim();

    const statusR = await cmd.dockerExec(containerName, "git status --porcelain", { source: src, timeout });
    result.dirty = statusR.ok && statusR.stdout.trim().length > 0;

    let defaultBranch = "main";
    const refR = await cmd.dockerExec(containerName, "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo refs/remotes/origin/main", { source: src, timeout: 5000 });
    if (refR.ok) {
      defaultBranch = refR.stdout.trim().replace("refs/remotes/origin/", "");
    }

    const aheadR = await cmd.dockerExec(containerName, `git rev-list --count origin/${defaultBranch}..HEAD`, { source: src, timeout });
    const behindR = await cmd.dockerExec(containerName, `git rev-list --count HEAD..origin/${defaultBranch}`, { source: src, timeout });
    result.aheadBy = aheadR.ok ? parseInt(aheadR.stdout.trim()) || 0 : 0;
    result.behindBy = behindR.ok ? parseInt(behindR.stdout.trim()) || 0 : 0;

    const mergedR = await cmd.dockerExec(containerName, `git branch -r --merged origin/${defaultBranch}`, { source: src, timeout });
    result.merged = mergedR.ok && mergedR.stdout.includes(`origin/${agentBranch}`);

    const logR = await cmd.dockerExec(containerName, 'git log -1 --format="%H|%s|%an|%aI"', { source: src, timeout });
    if (logR.ok && logR.stdout.trim()) {
      const [sha, message, author, date] = logR.stdout.trim().split("|");
      result.lastCommit = { sha, message, author, date };
    } else {
      result.lastCommit = null;
    }

    return true;
  } catch {
    return false;
  }
}

/** Clone repo for a new agent. */
export async function cloneRepo(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const cfg = store.getProjectConfig(projectPath);
  const agentDir = agent.agentDir!;

  if (existsSync(join(agentDir, ".git"))) return; // already cloned

  onProgress?.("cloning repository");

  // Ensure parent directory exists (agentRoot for new git/ structure, or agents/ for legacy)
  mkdirSync(dirname(agentDir), { recursive: true });

  let cloneUrl = cfg.REPO_URL || await simpleGit(projectPath).remote(["get-url", "origin"]) as unknown as string;
  if (typeof cloneUrl === "string") cloneUrl = cloneUrl.trim();
  const githubToken = cfg.GITHUB_TOKEN;
  if (githubToken && cloneUrl.startsWith("https://github.com/")) {
    cloneUrl = cloneUrl.replace(
      "https://github.com",
      `https://x-access-token:${githubToken}@github.com`
    );
  }

  if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });

  await simpleGit().clone(cloneUrl, agentDir, ["--depth", "50"]);

  const agentGit = simpleGit(agentDir);
  await agentGit.addConfig("credential.helper", "");
  await agentGit.addConfig("core.autocrlf", "input");

  // Shallow clone only tracks the default branch — widen refspec so fetch/rev-list
  // can resolve origin/agent/* and other branches.
  await agentGit.addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*", false);

  if (githubToken && cloneUrl.includes("x-access-token")) {
    await agentGit.remote(["set-url", "origin", cloneUrl]);
  }

  state.git.branch = agent.branch || `agent/${agent.issueId}`;
}

/** Remove the agent's repo directory.
 *  With new git/ structure, metadata at {agentRoot}/.10timesdev/ is untouched.
 *  With legacy structure (agentDir === agentRoot), falls back to selective cleanup. */
export async function removeRepo(
  agent: store.AgentData,
): Promise<void> {
  if (!agent.agentDir || !existsSync(agent.agentDir)) return;

  try { rmSync(agent.agentDir, { recursive: true, force: true }); } catch {}
}

/** Delete remote branch. */
export async function deleteRemoteBranch(
  agent: store.AgentData,
  projectPath: string,
): Promise<void> {
  try {
    await simpleGit(projectPath).push("origin", `:agent/${agent.issueId}`);
  } catch {
    // best effort
  }
}

/** Fetch from origin. */
export async function fetchRepo(
  agent: store.AgentData,
  state: AgentState,
): Promise<void> {
  if (!agent.agentDir) throw new Error("No agent directory");
  const src = `rebase:${agent.issueId}`;
  const result = await cmd.git("fetch origin", { cwd: agent.agentDir, source: src, timeout: 60_000 });
  if (!result.ok) {
    throw new Error(`fetch failed: ${result.stderr}`);
  }
}

/** Rebase agent branch onto default branch. Returns rebase result. */
export async function rebaseRepo(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
  onProgress?: (msg: string) => void,
): Promise<{ success: boolean; steps: Array<{ cmd: string; ok: boolean; output: string; ms: number }>; error?: string; conflict?: boolean; conflictFiles?: string[] }> {
  if (!agent.agentDir || !agent.branch) throw new Error("No agent directory or branch");

  const agentDir = agent.agentDir;
  const agentBranch = agent.branch;
  const src = `rebase:${agent.issueId}`;
  const steps: Array<{ cmd: string; ok: boolean; output: string; ms: number }> = [];

  async function step(label: string, gitCmd: string, timeoutMs = 30_000) {
    onProgress?.(label);
    const result = await cmd.git(gitCmd, { cwd: agentDir, source: src, timeout: timeoutMs });
    const output = result.ok
      ? result.stdout.substring(0, 500)
      : `${result.stderr.substring(0, 400)}\n---stdout---\n${result.stdout.substring(0, 100)}`;
    steps.push({ cmd: label, ok: result.ok, output, ms: result.ms });
    return result;
  }

  try {
    state.git.op = "rebasing";

    await step("config: credential.helper", 'config credential.helper ""', 5000);
    await step("config: user.email", 'config user.email "agent@10timesdev.com"', 5000);
    await step("config: user.name", 'config user.name "10timesdev Agent"', 5000);

    if (existsSync(join(agentDir, ".git", "rebase-merge")) || existsSync(join(agentDir, ".git", "rebase-apply"))) {
      await step("abort leftover rebase", "rebase --abort", 10_000);
    }

    const fetchResult = await step("fetch origin", "fetch origin", 60_000);
    if (!fetchResult.ok) return { success: false, steps, error: `fetch failed: ${fetchResult.stderr}` };

    const branchResult = await step("current branch", "rev-parse --abbrev-ref HEAD", 5000);
    const currentBranch = branchResult.stdout;

    if (currentBranch !== agentBranch) {
      const listResult = await step("list branches", "branch -a", 5000);
      const allBranches = listResult.stdout;
      const localExists = allBranches.split("\n").some(l => l.trim() === agentBranch || l.trim() === `* ${agentBranch}`);
      const remoteExists = allBranches.includes(`remotes/origin/${agentBranch}`);

      if (localExists) {
        const co = await step(`checkout ${agentBranch}`, `checkout "${agentBranch}"`, 10_000);
        if (!co.ok) return { success: false, steps, error: `checkout failed: ${co.stderr}` };
      } else if (remoteExists) {
        const co = await step("checkout -b from remote", `checkout -b "${agentBranch}" "origin/${agentBranch}"`, 10_000);
        if (!co.ok) return { success: false, steps, error: `checkout from remote failed: ${co.stderr}` };
      } else {
        const co = await step("create branch", `checkout -b "${agentBranch}"`, 10_000);
        if (!co.ok) return { success: false, steps, error: `branch creation failed: ${co.stderr}` };
      }
    }

    let didStash = false;
    const stashResult = await step("stash push", 'stash push --include-untracked -m "rebase-auto-stash"', 15_000);
    if (stashResult.ok && !stashResult.stdout.includes("No local changes")) didStash = true;

    const headBefore = (await step("HEAD before", "rev-parse HEAD", 5000)).stdout;

    let defaultBranch = "main";
    const refResult = await step("detect default branch", "symbolic-ref refs/remotes/origin/HEAD", 5000);
    if (refResult.ok) {
      defaultBranch = refResult.stdout.replace("refs/remotes/origin/", "");
    } else {
      const mainCheck = await step("verify origin/main", "rev-parse --verify origin/main", 5000);
      if (!mainCheck.ok) {
        const masterCheck = await step("verify origin/master", "rev-parse --verify origin/master", 5000);
        if (masterCheck.ok) defaultBranch = "master";
      }
    }

    const rebaseResult = await step(`rebase origin/${defaultBranch}`, `rebase "origin/${defaultBranch}"`, 60_000);

    if (!rebaseResult.ok) {
      const conflictResult = await step("conflict files", "diff --name-only --diff-filter=U", 5000);
      const conflictFiles = conflictResult.stdout.split("\n").filter(Boolean);
      await step("abort rebase", "rebase --abort", 10_000);
      if (didStash) await step("stash pop", "stash pop", 15_000);

      state.git.op = "idle";
      return { success: false, steps, error: `Conflicts in ${conflictFiles.length} file(s)`, conflict: true, conflictFiles };
    }

    const headAfter = (await step("HEAD after", "rev-parse HEAD", 5000)).stdout;
    const rebaseChanged = headBefore !== headAfter;

    let pushOk = true;
    if (rebaseChanged) {
      const pushResult = await step("push --force", `push --force origin "${agentBranch}"`, 60_000);
      if (!pushResult.ok) pushOk = false;
    } else {
      steps.push({ cmd: "push skipped", ok: true, output: "already up to date", ms: 0 });
    }

    if (didStash) await step("stash pop", "stash pop", 15_000);

    state.git.op = "idle";
    return { success: pushOk, steps, error: pushOk ? undefined : "push failed" };
  } catch (err) {
    steps.push({ cmd: "unexpected error", ok: false, output: String(err).substring(0, 500), ms: 0 });
    state.git.op = "idle";
    return { success: false, steps, error: String(err) };
  }
}

/** Merge agent branch into default branch. */
export async function mergeRepo(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
): Promise<{ commits: string; diffStats: string }> {
  if (!agent.branch) throw new Error("No agent branch");

  const git = simpleGit(projectPath);
  const branchName = agent.branch;
  const defaultBranch = await getDefaultBranch(git);

  state.git.op = "merging";

  try {
    await git.fetch("origin", branchName);

    const logResult = await git.log({ from: defaultBranch, to: `origin/${branchName}`, "--oneline": null });
    const commits = logResult.all.map(c => `${c.hash.slice(0, 7)} ${c.message}`).join("\n");
    const diffStats = (await git.diff(["--stat", `${defaultBranch}..origin/${branchName}`])).trim();

    if (!commits) throw new Error("No new commits to merge");

    const lastMsg = logResult.latest?.message || "";
    const issueId = agent.issueId;

    await git.merge([`origin/${branchName}`, "--no-ff", "-m", `Merge ${issueId}: ${lastMsg}`]);
    await git.push("origin", defaultBranch);

    state.git.op = "idle";
    return { commits, diffStats };
  } catch (err) {
    state.git.op = "idle";
    throw err;
  }
}

/** Checkout a specific branch in agent directory (used by restore). */
export async function checkoutBranch(agentDir: string, branch: string): Promise<void> {
  const git = simpleGit(agentDir);
  await git.fetch("origin", branch);
  await git.checkout(branch);
}

/** Push agent branch with --force. */
export async function pushRepo(
  agent: store.AgentData,
  state: AgentState,
): Promise<void> {
  if (!agent.agentDir || !agent.branch) throw new Error("No agent directory or branch");
  const result = await cmd.git(
    `push --force origin "${agent.branch}"`,
    { cwd: agent.agentDir, source: `push:${agent.issueId}`, timeout: 60_000 },
  );
  if (!result.ok) throw new Error(`push failed: ${result.stderr}`);
}
