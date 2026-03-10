// ---------------------------------------------------------------------------
// Git operations — extracted from rebase/route.ts, merge.ts, agent-lifecycle.ts
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import * as cmd from "@/lib/cmd";
import { simpleGit } from "@/lib/cmd";
import * as store from "@/lib/store";
import * as gitSvc from "@/services/git";
import * as portManager from "@/services/port-manager";
import { eventBus } from "@/lib/event-bus";
import type { AgentState, CurrentOperation } from "../types";

// Files managed by orchestrator — ignored in dirty checks, auto-committed before merge
const MANAGED_PATHS = new Set([".gitignore", ".config/"]);
const MANAGED_PREFIXES = [".10timesdev/", ".10timesdev\\", ".config/", ".config\\"];
// Lock/env files that don't count as meaningful changes
const NOISE_PATHS = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".env"]);

/** Check if a file path is orchestrator-managed or noise (not meaningful). */
function isIgnoredPath(filePath: string): boolean {
  return NOISE_PATHS.has(filePath) || MANAGED_PREFIXES.some(p => filePath.startsWith(p));
}

/** Check if a file is orchestrator-managed (eligible for auto-commit). */
function isManagedPath(filePath: string): boolean {
  return MANAGED_PATHS.has(filePath) || MANAGED_PREFIXES.some(p => filePath.startsWith(p));
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

      // Ignore filemode changes, lock files, and orchestrator-managed files
      await git.raw(["config", "core.fileMode", "false"]).catch(() => {});
      const statusResult = await git.status();
      const meaningfulChanges = statusResult.files.filter(f => !isIgnoredPath(f.path));
      result.dirty = meaningfulChanges.length > 0;

      const { ref: baseRef } = await gitSvc.getBaseRef(agent.agentDir!);

      try {
        const { ahead, behind } = await gitSvc.getAheadBehind(agent.agentDir!);
        result.aheadBy = ahead;
        result.behindBy = behind;
      } catch {
        result.aheadBy = 0;
        result.behindBy = 0;
      }

      try {
        result.merged = await gitSvc.isBranchMerged(agent.agentDir!, agentBranch);
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
      const merged = await gitSvc.isBranchMerged(projectPath, agentBranch);
      if (merged) {
        result.merged = true;
      }

      if (!result.merged) {
        // Look for merge commit in main's log (works after branch deletion)
        const { ref: baseRef } = await gitSvc.getBaseRef(projectPath);
        const projectGit = simpleGit(projectPath);
        const mergeLog = await projectGit.raw(["log", "--oneline", "--merges", "--grep", `Merge ${agent.issueId}`, baseRef, "-1"]);
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

    const statusR = await cmd.dockerExec(containerName, "git -c core.fileMode=false status --porcelain", { source: src, timeout });
    if (statusR.ok) {
      const lines = statusR.stdout.trim().split("\n").filter(l => l.trim());
      const meaningful = lines.filter(l => !isIgnoredPath(l.slice(3).trim()));
      result.dirty = meaningful.length > 0;
    }

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

  // Resolve clone URL: explicit config > git remote > local clone
  let cloneUrl: string | null = cfg.REPO_URL || null;
  if (!cloneUrl) {
    try {
      const url = await simpleGit(projectPath).remote(["get-url", "origin"]) as unknown as string;
      if (typeof url === "string" && url.trim()) cloneUrl = url.trim();
    } catch { /* no remote */ }
  }

  const githubToken = cfg.GITHUB_TOKEN || store.getDefaultRepoProviderInstance()?.config?.token;
  if (cloneUrl && githubToken && cloneUrl.startsWith("https://github.com/")) {
    cloneUrl = cloneUrl.replace(
      "https://github.com",
      `https://x-access-token:${githubToken}@github.com`
    );
  }

  if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });

  if (cloneUrl) {
    // Clone from remote
    await simpleGit().clone(cloneUrl, agentDir, ["--depth", "50"]);
  } else {
    // No remote — clone from local project dir
    await simpleGit().clone(projectPath, agentDir);
  }

  const agentGit = simpleGit(agentDir);
  await agentGit.addConfig("credential.helper", "");
  await agentGit.addConfig("core.autocrlf", "input");
  await agentGit.addConfig("core.filemode", "false");

  // Widen refspec so fetch/rev-list can resolve all remote branches.
  try {
    await agentGit.addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*", false);
  } catch { /* local clone may not have origin */ }

  if (cloneUrl && githubToken && cloneUrl.includes("x-access-token")) {
    await agentGit.remote(["set-url", "origin", cloneUrl]);
  }

  state.git.branch = agent.branch || `agent/${agent.issueId}`;
}

/** Remove the agent's repo directory. */
export async function removeRepo(
  agent: store.AgentData,
  projectPath?: string,
): Promise<void> {
  if (!agent.agentDir || !existsSync(agent.agentDir)) return;
  try { rmSync(agent.agentDir, { recursive: true, force: true }); } catch {}
}

/** Delete remote branch. */
export async function deleteRemoteBranch(
  agent: store.AgentData,
  projectPath: string,
): Promise<void> {
  await gitSvc.deleteRemoteBranch(projectPath, `agent/${agent.issueId}`);
}

/** Fetch from origin. */
export async function fetchRepo(
  agent: store.AgentData,
  state: AgentState,
): Promise<void> {
  if (!agent.agentDir) throw new Error("No agent directory");
  const ok = await gitSvc.fetchOrigin(agent.agentDir);
  if (!ok) throw new Error("fetch failed");
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

    // Detect if origin remote exists
    const remoteResult = await step("check remotes", "remote", 5000);
    const hasOrigin = remoteResult.ok && remoteResult.stdout.includes("origin");

    if (hasOrigin) {
      const fetchResult = await step("fetch origin", "fetch origin", 60_000);
      if (!fetchResult.ok) return { success: false, steps, error: `fetch failed: ${fetchResult.stderr}` };
    }

    const branchResult = await step("current branch", "rev-parse --abbrev-ref HEAD", 5000);
    const currentBranch = branchResult.stdout;

    if (currentBranch !== agentBranch) {
      const listResult = await step("list branches", "branch -a", 5000);
      const allBranches = listResult.stdout;
      const localExists = allBranches.split("\n").some(l => l.trim() === agentBranch || l.trim() === `* ${agentBranch}`);
      const remoteExists = hasOrigin && allBranches.includes(`remotes/origin/${agentBranch}`);

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

    // Detect default branch — use origin refs if available, else local
    let defaultBranch = "main";
    if (hasOrigin) {
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
    } else {
      const branchList = await step("list local branches", "branch", 5000);
      if (!branchList.stdout.includes("main")) {
        if (branchList.stdout.includes("master")) defaultBranch = "master";
      }
    }

    const rebaseTarget = hasOrigin ? `origin/${defaultBranch}` : defaultBranch;
    const rebaseResult = await step(`rebase ${rebaseTarget}`, `rebase "${rebaseTarget}"`, 60_000);

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
    if (hasOrigin && rebaseChanged) {
      const pushResult = await step("push --force", `push --force origin "${agentBranch}"`, 60_000);
      if (!pushResult.ok) pushOk = false;
    } else {
      steps.push({ cmd: "push skipped", ok: true, output: hasOrigin ? "already up to date" : "no remote", ms: 0 });
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

/** Push agent branch to the project repo.
 *  If the clone has origin → push there.
 *  If not → fetch from agent dir into project repo. */
export async function pushBranchToRemote(
  agent: store.AgentData,
  projectPath: string,
): Promise<boolean> {
  if (!agent.branch || !agent.agentDir) return false;
  if (!existsSync(join(agent.agentDir, ".git"))) return false;

  const hasOrigin = await gitSvc.hasOrigin(agent.agentDir).catch(() => false);

  if (hasOrigin) {
    const agentGit = simpleGit(agent.agentDir);
    await agentGit.push("origin", agent.branch, ["--force"]);
    return true;
  }

  // No remote — fetch agent branch into project repo from agent dir
  // Clean up any stale worktree registrations that block the fetch
  const projectGit = simpleGit(projectPath);
  try { await projectGit.raw(["worktree", "prune"]); } catch {}
  const wtDir = join(projectPath, ".git", "worktrees");
  if (existsSync(wtDir)) {
    try { rmSync(wtDir, { recursive: true, force: true }); } catch {}
  }
  await projectGit.fetch(agent.agentDir, `${agent.branch}:${agent.branch}`, ["--force"]);
  return true;
}

/** Merge agent branch into default branch.
 *  1) Push agent branch to remote  2) Fetch in project dir  3) Merge  4) Push default branch */
export async function mergeRepo(
  agent: store.AgentData,
  projectPath: string,
  state: AgentState,
): Promise<{ commits: string; diffStats: string }> {
  if (!agent.branch) throw new Error("No agent branch");

  const git = simpleGit(projectPath);
  const branchName = agent.branch;
  const defaultBranch = await gitSvc.getDefaultBranch(projectPath);
  const hasOrigin = await gitSvc.hasOrigin(projectPath);

  state.git.op = "merging";

  let didStash = false;

  try {
    // 0. Auto-commit orchestrator-managed files if they're dirty (prevents merge failures)
    try {
      const status = await git.status();
      const dirty = status.files.filter(f => f.path !== "");
      if (dirty.length > 0) {
        const managedDirty = dirty.filter(f => isManagedPath(f.path));
        const otherDirty = dirty.filter(f => !isManagedPath(f.path));

        if (managedDirty.length > 0 && otherDirty.length === 0) {
          // Only orchestrator files are dirty — auto-commit them
          await git.add(managedDirty.map(f => f.path));
          await git.commit("chore: update orchestrator-managed files");
        } else if (dirty.length > 0) {
          // Other files dirty too — stash everything
          const stashResult = await git.stash(["push", "--include-untracked", "-m", "merge-auto-stash"]);
          didStash = !stashResult.includes("No local changes");
        }
      }
    } catch {}

    // 1. Push agent branch to remote
    try { await pushBranchToRemote(agent, projectPath); } catch { /* best effort */ }

    // 2. Fetch the branch in project dir
    if (hasOrigin) {
      try { await git.fetch("origin", branchName); } catch { /* may not be on remote yet */ }
    }

    // 3. Checkout default branch, pull latest
    await git.checkout(defaultBranch);
    if (hasOrigin) {
      try { await git.pull("origin", defaultBranch, ["--ff-only"]); } catch {}
    }

    // 4. Determine merge ref — prefer origin/ if available, else local branch
    let mergeRef = branchName;
    if (hasOrigin) {
      const remoteExists = await git.raw(["rev-parse", "--verify", `origin/${branchName}`]).then(() => true).catch(() => false);
      if (remoteExists) mergeRef = `origin/${branchName}`;
    }

    // 5. Gather commit info
    const logResult = await git.log({ from: defaultBranch, to: mergeRef, "--oneline": null });
    const commits = logResult.all.map(c => `${c.hash.slice(0, 7)} ${c.message}`).join("\n");
    const diffStats = (await git.diff(["--stat", `${defaultBranch}..${mergeRef}`])).trim();
    if (!commits) throw new Error("No new commits to merge");

    // 6. Merge
    const lastMsg = logResult.latest?.message || "";
    await git.merge([mergeRef, "--no-ff", "-m", `Merge ${agent.issueId}: ${lastMsg}`]);

    // 7. Push default branch
    if (hasOrigin) {
      await git.push("origin", defaultBranch);
    }

    // 8. Cleanup local branch
    try { await git.branch(["-d", branchName]); } catch {}

    // 9. Restore stashed changes
    if (didStash) { try { await git.stash(["pop"]); } catch {} }

    state.git.op = "idle";
    return { commits, diffStats };
  } catch (err) {
    if (didStash) { try { await git.stash(["pop"]); } catch {} }
    state.git.op = "idle";
    throw err;
  }
}


/** Create agent branch, commit .gitignore, configure git user. */
export async function setupAgentBranch(agentDir: string, branchName: string): Promise<void> {
  const git = simpleGit(agentDir);

  // Configure git user for agent commits
  await git.addConfig("user.email", "agent@10timesdev.com");
  await git.addConfig("user.name", "10timesdev Agent");

  // Create and checkout agent branch
  await git.checkoutLocalBranch(branchName);

  // Commit .gitignore if it has changes
  await commitGitIgnoreIfNeeded(agentDir);
}

/** Commit .gitignore changes if any (used after ensureGitIgnored). */
export async function commitGitIgnoreIfNeeded(agentDir: string): Promise<void> {
  const git = simpleGit(agentDir);
  const status = await git.status();
  const gitignoreChanged = status.files.some(f => f.path === ".gitignore");
  if (gitignoreChanged) {
    // Ensure git user is configured
    try { await git.addConfig("user.email", "agent@10timesdev.com"); } catch {}
    try { await git.addConfig("user.name", "10timesdev Agent"); } catch {}
    await git.add(".gitignore");
    await git.commit("chore: add orchestrator files to .gitignore");
  }
}

/** Checkout a specific branch in agent directory (used by restore). */
export async function checkoutBranch(agentDir: string, branch: string): Promise<void> {
  const git = simpleGit(agentDir);
  const hasRemote = await gitSvc.hasOrigin(agentDir).catch(() => false);
  if (hasRemote) {
    try { await git.fetch("origin", branch); } catch {}
  }
  await git.checkout(branch);
}

/** Push agent branch with --force. */
export async function pushRepo(
  agent: store.AgentData,
  state: AgentState,
): Promise<void> {
  if (!agent.agentDir || !agent.branch) throw new Error("No agent directory or branch");
  const result = await gitSvc.forcePush(agent.agentDir, agent.branch);
  if (!result.ok) throw new Error(`push failed: ${result.error}`);
}
