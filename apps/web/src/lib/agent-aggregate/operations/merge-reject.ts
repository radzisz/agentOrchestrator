// ---------------------------------------------------------------------------
// Merge / Reject / Rebase operations
// ---------------------------------------------------------------------------

import * as gitSvc from "@/services/git";
import { eventBus } from "@/lib/event-bus";
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
  ctx.state.git.rebaseConflict = false;
  ctx.persist();

  const result = await gitOps.rebaseRepo(ctx.agent, ctx.projectPath, ctx.state, setProgress);
  ctx.agent.rebaseResult = result;
  ctx.state.git.rebaseConflict = !!result.conflict;

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
    setProgress("pushing branch and merging");
    try {
      mergeResult = await gitOps.mergeRepo(ctx.agent, ctx.projectPath, ctx.state);
    } catch (mergeErr) {
      // Abort any in-progress merge in project dir and restore clean state
      try {
        const git = (await import("@/lib/cmd")).simpleGit(ctx.projectPath);
        await git.raw(["merge", "--abort"]).catch(() => {});
        const defaultBranch = await gitSvc.getDefaultBranch(ctx.projectPath);
        await git.checkout(defaultBranch).catch(() => {});
      } catch {}
      ctx.state.git.op = "idle";
      ctx.persist();
      throw mergeErr;
    }
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

  const defaultBranch = await gitSvc.getDefaultBranch(ctx.projectPath);

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
    // Comment without closing — use tracker abstraction
    await trackerOps.addComment(ctx.agent, ctx.projectPath, `✅ Merged to ${defaultBranch}${toggleMsg}`);
  }

  if (closeIssue) {
    ctx.state.trackerStatus = "done";
    ctx.state.linearStatus = "done";
  }
  ctx.persist();

  ctx.opLog("mergeAndClose", `merged commits=${mergeResult.commits}`);
  eventBus.emit("agent:merged", { agentId: ctx.issueId, issueId: ctx.issueId, branch: ctx.agent.branch || "" });

  // Pull main branch in the host project so it picks up the merged changes
  try {
    setProgress("pulling main branch");
    await gitSvc.pullMainBranch(ctx.projectPath);
    ctx.opLog("mergeAndClose", "pulled main branch");
  } catch (err) {
    ctx.opLog("mergeAndClose", `pull main failed (non-critical): ${err}`);
  }

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
    await gitOps.removeRepo(ctx.agent, ctx.projectPath).catch(() => {});

    ctx.persist();
    ctx.opLog("mergeAndClose", "cleanup complete");
  }

  return mergeResult;
}

/** Reject agent: cancel tracker issue. */
export async function reject(
  ctx: AggregateContext,
  closeIssue = true,
): Promise<void> {
  if (closeIssue) {
    // Use tracker abstraction — works for Linear, local, Sentry, etc.
    await trackerOps.cancelIssue(
      ctx.agent,
      ctx.projectPath,
      ctx.state,
      "❌ Odrzucone — nie mergowane",
    );
  } else {
    // Just comment without changing state — use tracker abstraction
    await trackerOps.addComment(ctx.agent, ctx.projectPath, "❌ Odrzucone — nie mergowane");
  }
  const newStatus = closeIssue ? "cancelled" as const : "in_progress" as const;
  ctx.state.trackerStatus = newStatus;
  ctx.state.linearStatus = newStatus;
  ctx.persist();
  ctx.opLog("reject", `rejected closeIssue=${closeIssue}`);
}
