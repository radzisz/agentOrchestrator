// ---------------------------------------------------------------------------
// Remove agent operation
// ---------------------------------------------------------------------------

import { eventBus } from "@/lib/event-bus";
import type { AggregateContext } from "../types";
import * as containerOps from "./container";
import * as agentProcessOps from "./agent-process";
import * as serviceOps from "./services";
import * as gitOps from "./git";
import * as trackerOps from "./tracker";

/** Remove agent: optionally close Linear → stop → stop services → remove container → remove repo. */
export async function removeAgent(
  ctx: AggregateContext,
  setProgress: (msg: string) => void,
  opts?: { closeIssue?: boolean; deleteBranch?: boolean },
): Promise<void> {
  // Safety: if agent is actively running, stop it first
  if (ctx.state.agent === "running") {
    setProgress("stopping running agent");
    await agentProcessOps.stopAgentProcess(ctx.agent, ctx.state, ctx.projectPath).catch(() => {});
  }

  // Close Linear FIRST (before destroying anything)
  if (opts?.closeIssue) {
    setProgress("closing Linear issue");
    try {
      await trackerOps.cancelIssue(ctx.agent, ctx.projectPath, ctx.state);
    } catch (err) {
      ctx.opLog("remove", `Linear close failed (continuing): ${err}`);
    }
  }

  ctx.setLifecycle("removed");
  ctx.persist();
  eventBus.emit("agent:cleanup", { agentId: ctx.issueId, issueId: ctx.issueId });

  setProgress("stopping services");
  await serviceOps.stopAllServices(ctx.agent, ctx.projectName, ctx.projectPath, ctx.state).catch(() => {});

  setProgress("removing container");
  await containerOps.removeContainerAndVolume(ctx.agent, ctx.state).catch(() => {});

  setProgress("removing repository");
  if (opts?.deleteBranch !== false) {
    await gitOps.deleteRemoteBranch(ctx.agent, ctx.projectPath).catch(() => {});
  }
  await gitOps.removeRepo(ctx.agent).catch(() => {});

  ctx.persist();
  ctx.opLog("remove", "cleanup complete");
}
