// ---------------------------------------------------------------------------
// Centralized Git Service — all git operations go through here.
// Handles "has origin" logic internally so callers never need to check.
// ---------------------------------------------------------------------------

import { existsSync } from "fs";
import { join } from "path";
import * as cmd from "@/lib/cmd";
import { simpleGit } from "@/lib/cmd";

const SRC = "git-svc";

// ---------------------------------------------------------------------------
// Core primitives
// ---------------------------------------------------------------------------

/** Check whether a repo has an "origin" remote configured. */
export async function hasOrigin(cwd: string): Promise<boolean> {
  const r = await cmd.git(`-C "${cwd}" remote`, { source: SRC, timeout: 5000 });
  return r.ok && r.stdout.includes("origin");
}

/** Detect default branch (main/master) respecting origin presence. */
export async function getDefaultBranch(cwd: string): Promise<string> {
  const origin = await hasOrigin(cwd);

  if (origin) {
    const refR = await cmd.git(
      `-C "${cwd}" symbolic-ref refs/remotes/origin/HEAD`,
      { source: SRC, timeout: 5000 },
    );
    if (refR.ok && refR.stdout) {
      return refR.stdout.replace("refs/remotes/origin/", "").trim();
    }
    const mainR = await cmd.git(
      `-C "${cwd}" rev-parse --verify origin/main`,
      { source: SRC, timeout: 5000 },
    );
    if (mainR.ok) return "main";
    return "master";
  }

  // No origin: check local branches
  const branchR = await cmd.git(`-C "${cwd}" branch`, { source: SRC, timeout: 5000 });
  if (branchR.ok) {
    if (branchR.stdout.includes("main")) return "main";
    if (branchR.stdout.includes("master")) return "master";
  }
  return "main";
}

/**
 * Get the base ref for comparisons.
 * Returns "origin/main" when origin exists, "main" otherwise.
 */
export async function getBaseRef(cwd: string): Promise<{
  ref: string;
  hasOrigin: boolean;
  defaultBranch: string;
}> {
  const origin = await hasOrigin(cwd);
  const defaultBranch = await getDefaultBranchWithOrigin(cwd, origin);
  return {
    ref: origin ? `origin/${defaultBranch}` : defaultBranch,
    hasOrigin: origin,
    defaultBranch,
  };
}

// ---------------------------------------------------------------------------
// Branch queries
// ---------------------------------------------------------------------------

/**
 * Check if a branch exists on the remote via ls-remote.
 * Returns `true` (exists), `false` (confirmed gone), or `null` (network error).
 */
export async function branchExistsOnRemote(
  cwd: string,
  branch: string,
): Promise<boolean | null> {
  if (!(await hasOrigin(cwd))) return null;
  const r = await cmd.git(
    `-C "${cwd}" ls-remote --heads origin "${branch}"`,
    { source: SRC, timeout: 10_000 },
  );
  if (!r.ok) return null;
  return r.stdout.trim().length > 0;
}

/** Check if branch is fully merged into default branch. */
export async function isBranchMerged(
  cwd: string,
  branch: string,
): Promise<boolean> {
  const { ref: baseRef, hasOrigin: origin } = await getBaseRef(cwd);
  const flag = origin ? "-r" : "";
  const mergedR = await cmd.git(
    `-C "${cwd}" branch ${flag} --merged "${baseRef}"`,
    { source: SRC, timeout: 10_000 },
  );
  if (!mergedR.ok) return false;
  const target = origin ? `origin/${branch}` : branch;
  return mergedR.stdout.split("\n").some((l) => l.trim() === target);
}

/** Get ahead/behind counts relative to base ref. */
export async function getAheadBehind(
  cwd: string,
  headRef = "HEAD",
): Promise<{ ahead: number; behind: number }> {
  const { ref: baseRef } = await getBaseRef(cwd);
  try {
    const aheadR = await cmd.git(
      `-C "${cwd}" rev-list --count "${baseRef}..${headRef}"`,
      { source: SRC, timeout: 5000 },
    );
    const behindR = await cmd.git(
      `-C "${cwd}" rev-list --count "${headRef}..${baseRef}"`,
      { source: SRC, timeout: 5000 },
    );
    return {
      ahead: aheadR.ok ? parseInt(aheadR.stdout.trim()) || 0 : 0,
      behind: behindR.ok ? parseInt(behindR.stdout.trim()) || 0 : 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

/** Get left-right ahead/behind in a single call. */
export async function getLeftRight(
  cwd: string,
  baseRef: string,
  headRef = "HEAD",
): Promise<{ behind: number; ahead: number }> {
  const countR = await cmd.git(
    `-C "${cwd}" rev-list --left-right --count "${baseRef}...${headRef}"`,
    { source: SRC, timeout: 5000 },
  );
  if (countR.ok && countR.stdout) {
    const [behind, ahead] = countR.stdout.split(/\s+/).map(Number);
    return { behind: behind || 0, ahead: ahead || 0 };
  }
  return { behind: 0, ahead: 0 };
}

// ---------------------------------------------------------------------------
// Commit queries
// ---------------------------------------------------------------------------

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/** Get the latest commit on HEAD (or a given ref). */
export async function getLastCommit(
  cwd: string,
  ref = "HEAD",
): Promise<CommitInfo | null> {
  const r = await cmd.git(
    `-C "${cwd}" log -1 --format="%H|%s|%an|%aI" "${ref}"`,
    { source: SRC, timeout: 5000 },
  );
  if (!r.ok || !r.stdout.trim()) return null;
  const parts = r.stdout.trim().split("|");
  const sha = parts[0];
  const date = parts.pop()!;
  const author = parts.pop()!;
  const message = parts.slice(1).join("|");
  return { sha, message, author, date };
}

/** Get commit log between two refs. Format: "hash message" per line. */
export async function getLog(
  cwd: string,
  baseRef: string,
  headRef: string,
): Promise<{ hash: string; message: string }[]> {
  const logR = await cmd.git(
    `-C "${cwd}" log --format="%H %s" "${baseRef}..${headRef}"`,
    { source: SRC, timeout: 10_000 },
  );
  if (!logR.ok || !logR.stdout) return [];
  return logR.stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, ...rest] = line.split(" ");
    return { hash, message: rest.join(" ") };
  });
}

/** Get diff --stat summary between two refs. */
export async function getDiffStat(
  cwd: string,
  baseRef: string,
  headRef: string,
): Promise<string> {
  const r = await cmd.git(
    `-C "${cwd}" diff --stat "${baseRef}..${headRef}"`,
    { source: SRC, timeout: 15_000 },
  );
  return r.ok ? r.stdout.trim() : "";
}

// ---------------------------------------------------------------------------
// Status checks
// ---------------------------------------------------------------------------

/** Get porcelain status. */
export async function getStatus(
  cwd: string,
): Promise<{ dirty: boolean; files: string[] }> {
  const r = await cmd.git(`-C "${cwd}" status --porcelain`, { source: SRC, timeout: 10_000 });
  const lines = r.ok ? r.stdout.trim() : "";
  return {
    dirty: lines.length > 0,
    files: lines ? lines.split("\n").slice(0, 50) : [],
  };
}

/** Get the current branch name. */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const r = await cmd.git(`-C "${cwd}" rev-parse --abbrev-ref HEAD`, { source: SRC, timeout: 5000 });
  return r.ok ? r.stdout.trim() : "";
}

/** Check and abort a stuck rebase. Returns whether one was aborted. */
export async function abortRebaseIfStuck(cwd: string): Promise<boolean> {
  const rebaseMerge = join(cwd, ".git", "rebase-merge");
  const rebaseApply = join(cwd, ".git", "rebase-apply");

  if (!existsSync(rebaseMerge) && !existsSync(rebaseApply)) return false;

  try {
    await simpleGit(cwd).rebase(["--abort"]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** Fetch from origin. No-op if no origin. Returns success. */
export async function fetchOrigin(
  cwd: string,
  branch?: string,
  opts?: { deepen?: number; quiet?: boolean; timeout?: number },
): Promise<boolean> {
  if (!(await hasOrigin(cwd))) return true;

  let args = "fetch origin";
  if (branch) args += ` "${branch}"`;
  if (opts?.quiet) args += " --quiet";
  if (opts?.deepen) args += ` --deepen=${opts.deepen}`;

  const r = await cmd.git(`-C "${cwd}" ${args}`, {
    source: SRC,
    timeout: opts?.timeout ?? 60_000,
  });
  return r.ok;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/** Configure git user for agent commits. */
export async function configureAgentUser(cwd: string): Promise<void> {
  const o = { source: SRC, timeout: 5000 };
  await cmd.git(`-C "${cwd}" config user.email "agent@10timesdev.com"`, o);
  await cmd.git(`-C "${cwd}" config user.name "10timesdev Agent"`, o);
  await cmd.git(`-C "${cwd}" config credential.helper ""`, o);
}

/**
 * Stage files, commit, and push.
 * Push is skipped if no origin remote.
 */
export async function commitAndPush(
  cwd: string,
  message: string,
  opts?: { files?: string[]; pushRef?: string },
): Promise<{ ok: boolean; error?: string }> {
  await configureAgentUser(cwd);

  const addTarget = opts?.files?.length
    ? opts.files.map((f) => `"${f}"`).join(" ")
    : "-A";
  const addR = await cmd.git(`-C "${cwd}" add ${addTarget}`, { source: SRC });
  if (!addR.ok) return { ok: false, error: addR.stderr || "add failed" };

  const safeMsg = message.trim().replace(/'/g, "'\\''");
  const commitR = await cmd.git(`-C "${cwd}" commit -m '${safeMsg}'`, { source: SRC });
  if (!commitR.ok) return { ok: false, error: commitR.stderr || "commit failed" };

  if (await hasOrigin(cwd)) {
    const pushTarget = opts?.pushRef || "HEAD";
    const pushR = await cmd.git(`-C "${cwd}" push origin ${pushTarget}`, {
      source: SRC,
      timeout: 30_000,
    });
    if (!pushR.ok) return { ok: false, error: pushR.stderr || "push failed" };
  }

  return { ok: true };
}

/** Force push a branch. Skips if no origin. Refuses main/master. */
export async function forcePush(
  cwd: string,
  branch: string,
): Promise<{ ok: boolean; error?: string }> {
  if (branch === "main" || branch === "master") {
    return { ok: false, error: `Refusing to force-push ${branch}` };
  }
  if (!(await hasOrigin(cwd))) {
    return { ok: true };
  }
  const r = await cmd.git(`-C "${cwd}" push --force origin "${branch}"`, {
    source: SRC,
    timeout: 60_000,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.stderr };
}

/** Push with --force-with-lease. Skips if no origin. */
export async function forcePushWithLease(
  cwd: string,
  branch: string,
): Promise<{ ok: boolean; error?: string }> {
  if (branch === "main" || branch === "master") {
    return { ok: false, error: `Refusing to push ${branch}` };
  }
  if (!(await hasOrigin(cwd))) {
    return { ok: true };
  }
  const r = await cmd.git(
    `-C "${cwd}" push origin "HEAD:refs/heads/${branch}" --force-with-lease`,
    { source: SRC, timeout: 60_000 },
  );
  return r.ok ? { ok: true } : { ok: false, error: r.stderr };
}

/** Fetch + checkout a branch. Handles origin presence. */
export async function fetchAndCheckout(
  cwd: string,
  branch: string,
): Promise<{ ok: boolean; error?: string }> {
  const git = simpleGit(cwd);
  const origin = await hasOrigin(cwd);

  try {
    if (origin) {
      await git.fetch("origin");
      await git.checkout(["-B", branch, `origin/${branch}`]);
    } else {
      await git.checkout(branch);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Checkout default branch (to leave repo in clean state after branch ops). */
export async function checkoutDefault(cwd: string): Promise<void> {
  const defaultBranch = await getDefaultBranch(cwd);
  try {
    await simpleGit(cwd).checkout(defaultBranch);
  } catch {
    // best effort
  }
}

/** Pull the default branch in the host project directory. No-op if no origin. */
export async function pullMainBranch(cwd: string): Promise<void> {
  if (!(await hasOrigin(cwd))) return;
  const defaultBranch = await getDefaultBranch(cwd);
  const git = simpleGit(cwd);
  const current = await git.revparse(["--abbrev-ref", "HEAD"]);
  if (current.trim() !== defaultBranch) {
    return;
  }
  await git.pull("origin", defaultBranch, ["--ff-only"]);
}

/** Delete a remote branch. No-op if no origin. */
export async function deleteRemoteBranch(
  cwd: string,
  branch: string,
): Promise<void> {
  if (!(await hasOrigin(cwd))) return;
  try {
    await simpleGit(cwd).push("origin", `:${branch}`);
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function getDefaultBranchWithOrigin(cwd: string, origin: boolean): Promise<string> {
  if (origin) {
    const refR = await cmd.git(
      `-C "${cwd}" symbolic-ref refs/remotes/origin/HEAD`,
      { source: SRC, timeout: 5000 },
    );
    if (refR.ok && refR.stdout) {
      return refR.stdout.replace("refs/remotes/origin/", "").trim();
    }
    const mainR = await cmd.git(
      `-C "${cwd}" rev-parse --verify origin/main`,
      { source: SRC, timeout: 5000 },
    );
    if (mainR.ok) return "main";
    return "master";
  }

  const branchR = await cmd.git(`-C "${cwd}" branch`, { source: SRC, timeout: 5000 });
  if (branchR.ok) {
    if (branchR.stdout.includes("main")) return "main";
    if (branchR.stdout.includes("master")) return "master";
  }
  return "main";
}
