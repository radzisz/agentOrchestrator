// ---------------------------------------------------------------------------
// Status / Merge-info query operations
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import { simpleGit } from "@/lib/cmd";
import { getContainerStatus, isProcessRunning } from "@/lib/docker";
import { resolveProviderConfig, getProviderDriver } from "../ai-provider";
import { deriveUiStatus } from "../types";
import type { AggregateContext, CurrentOperation } from "../types";

/** Get full status (equivalent to agent-lifecycle.getStatus). */
export async function getStatus(ctx: AggregateContext, currentOperation: CurrentOperation | null) {
  let containerStatus = null;
  if (ctx.agent.containerName) {
    containerStatus = await getContainerStatus(ctx.agent.containerName);
  }
  let claudeRunning = false;
  if (ctx.agent.containerName && containerStatus?.status === "running") {
    const cfg = store.getProjectConfig(ctx.projectPath);
    const driver = getProviderDriver(resolveProviderConfig(ctx.agent, cfg));
    claudeRunning = await isProcessRunning(ctx.agent.containerName, driver.processPattern);
  }
  return {
    agent: ctx.agent,
    containerStatus,
    projectName: ctx.projectName,
    claudeRunning,
    state: ctx.state,
    currentOperation,
    uiStatus: deriveUiStatus(ctx.state, currentOperation),
  };
}

/** Get merge info (commits + diff stats). */
export async function getMergeInfo(ctx: AggregateContext): Promise<{ commits: string; diffStats: string }> {
  const git = simpleGit(ctx.projectPath);
  const branchName = ctx.agent.branch || `agent/${ctx.issueId}`;
  let defaultBranch = "main";
  try {
    const ref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    defaultBranch = ref.trim().replace("refs/remotes/origin/", "");
  } catch {
    try { await git.raw(["rev-parse", "--verify", "origin/main"]); } catch { defaultBranch = "master"; }
  }

  await git.fetch("origin", branchName);
  const logResult = await git.log({ from: defaultBranch, to: `origin/${branchName}`, "--oneline": null });
  const commits = logResult.all.map(c => `${c.hash.slice(0, 7)} ${c.message}`).join("\n");
  const diffStats = (await git.diff(["--stat", `${defaultBranch}..origin/${branchName}`])).trim();

  return { commits, diffStats };
}
