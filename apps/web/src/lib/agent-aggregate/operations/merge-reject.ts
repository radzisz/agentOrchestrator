// ---------------------------------------------------------------------------
// Merge / Reject / Rebase operations
// ---------------------------------------------------------------------------

import { simpleGit } from "@/lib/cmd";
import { linearApi as linear } from "@orchestrator/tracker-linear";
import { eventBus } from "@/lib/event-bus";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";
import type { AggregateContext } from "../types";
import * as containerOps from "./container";
import * as serviceOps from "./services";
import * as gitOps from "./git";
import * as trackerOps from "./tracker";

/** Rebase agent branch onto default branch. */
export async function rebase(
  ctx: AggregateContext,
  setProgress: (msg: string) => void,
): Promise<{ success: boolean; steps: any[]; error?: string; conflict?: boolean; conflictFiles?: string[] }> {
  ctx.agent.rebaseResult = undefined;
  ctx.state.git.op = "rebasing";
  ctx.persist();

  const result = await gitOps.rebaseRepo(ctx.agent, ctx.projectPath, ctx.state, setProgress);
  ctx.agent.rebaseResult = result;

  // If conflict, wake the agent with conflict message (done in aggregate to avoid circular dep)
  ctx.opLog("rebase", `result: success=${result.success}`);
  ctx.persist();

  return result;
}

/** Merge agent branch and close Linear issue. */
export async function mergeAndClose(
  ctx: AggregateContext,
  setProgress: (msg: string) => void,
  opts?: { toggle?: boolean; enableToggle?: boolean; closeIssue?: boolean; cleanup?: boolean; skipMerge?: boolean },
): Promise<{ commits: string; diffStats: string }> {
  let mergeResult: { commits: string; diffStats: string } = { commits: "", diffStats: "" };
  const closeIssue = opts?.closeIssue ?? true;

  if (!opts?.skipMerge) {
    setProgress("fetching and merging");
    mergeResult = await gitOps.mergeRepo(ctx.agent, ctx.projectPath, ctx.state);
  } else {
    ctx.opLog("mergeAndClose", "skipping merge (branch already merged)");
  }

  // Build toggle message
  let toggleMsg = "";
  if (opts?.toggle) {
    const toggleName = ctx.issueId.toLowerCase().replace("-", "_");
    toggleMsg = opts.enableToggle
      ? ` z toggle **${toggleName}** = ON`
      : ` z toggle **${toggleName}** = OFF (kod w produkcji, ficzer nieaktywny)`;
  }

  const git = simpleGit(ctx.projectPath);
  let defaultBranch = "main";
  try {
    const ref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    defaultBranch = ref.trim().replace("refs/remotes/origin/", "");
  } catch {}

  // Close tracker issue
  if (closeIssue) {
    setProgress("closing tracker issue");
    await trackerOps.closeIssue(
      ctx.agent,
      ctx.projectPath,
      ctx.state,
      `✅ Merged to ${defaultBranch}${toggleMsg}`,
    );
  } else {
    const linearCfg = resolveTrackerConfig(ctx.projectPath, "linear");
    if (ctx.agent.linearIssueUuid && linearCfg?.apiKey) {
      await linear.addComment(linearCfg.apiKey, ctx.agent.linearIssueUuid, `✅ Merged to ${defaultBranch}${toggleMsg}`);
    }
  }

  if (closeIssue) {
    ctx.state.trackerStatus = "done";
    ctx.state.linearStatus = "done";
  }
  ctx.persist();

  ctx.opLog("mergeAndClose", `merged commits=${mergeResult.commits}`);
  eventBus.emit("agent:merged", { agentId: ctx.issueId, issueId: ctx.issueId, branch: ctx.agent.branch || "" });

  // Inline cleanup (cannot call removeAgent — it would deadlock on withLock)
  if (opts?.cleanup) {
    ctx.setLifecycle("removed");
    ctx.persist();
    eventBus.emit("agent:cleanup", { agentId: ctx.issueId, issueId: ctx.issueId });

    setProgress("stopping services");
    await serviceOps.stopAllServices(ctx.agent, ctx.projectName, ctx.projectPath, ctx.state).catch(() => {});

    setProgress("removing container");
    await containerOps.removeContainerAndVolume(ctx.agent, ctx.state).catch(() => {});

    setProgress("removing repository");
    await gitOps.deleteRemoteBranch(ctx.agent, ctx.projectPath).catch(() => {});
    await gitOps.removeRepo(ctx.agent).catch(() => {});

    ctx.persist();
    ctx.opLog("mergeAndClose", "cleanup complete");
  }

  return mergeResult;
}

/** Reject agent: cancel Linear issue. */
export async function reject(
  ctx: AggregateContext,
  closeIssue = true,
): Promise<void> {
  const linearCfg = resolveTrackerConfig(ctx.projectPath, "linear");
  if (ctx.agent.linearIssueUuid && linearCfg?.apiKey) {
    // Always comment
    await linear.addComment(linearCfg.apiKey, ctx.agent.linearIssueUuid, "❌ Odrzucone — nie mergowane");
    // Only change Linear state if closeIssue
    if (closeIssue) {
      await trackerOps.cancelIssue(ctx.agent, ctx.projectPath, ctx.state);
    }
  }
  const newStatus = closeIssue ? "cancelled" as const : "in_progress" as const;
  ctx.state.trackerStatus = newStatus;
  ctx.state.linearStatus = newStatus;
  ctx.persist();
  ctx.opLog("reject", `rejected closeIssue=${closeIssue}`);
}
