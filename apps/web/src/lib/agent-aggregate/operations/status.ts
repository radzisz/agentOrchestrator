// ---------------------------------------------------------------------------
// Status / Merge-info query operations
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import * as gitSvc from "@/services/git";
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
  const branchName = ctx.agent.branch || `agent/${ctx.issueId}`;
  const { ref: baseRef, hasOrigin } = await gitSvc.getBaseRef(ctx.projectPath);

  if (hasOrigin) {
    await gitSvc.fetchOrigin(ctx.projectPath, branchName);
  }

  const headRef = hasOrigin ? `origin/${branchName}` : branchName;
  const log = await gitSvc.getLog(ctx.projectPath, baseRef, headRef);
  const commits = log.map(c => `${c.hash.slice(0, 7)} ${c.message}`).join("\n");

  const diffStats = await gitSvc.getDiffStat(ctx.projectPath, baseRef, headRef);

  return { commits, diffStats };
}
