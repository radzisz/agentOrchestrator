// ---------------------------------------------------------------------------
// Backward compatibility: derive legacy AgentStatus from new AgentState
// and bootstrap AgentState from legacy AgentData.
// ---------------------------------------------------------------------------

import type { AgentStatus, AgentData } from "@/lib/store";
import type { AgentState, CurrentOperation } from "./types";
import { defaultAgentState } from "./types";

/**
 * Derive the old monolithic AgentStatus from the new state axes + current operation.
 * This lets existing UI code keep working without changes.
 */
export function deriveLegacyStatus(
  state: AgentState,
  op: CurrentOperation | null,
): AgentStatus {
  // Active operations take priority
  if (op) {
    switch (op.name) {
      case "spawn":
      case "restore":
        return "SPAWNING";
      case "rebase":
        return "REBASING";
      case "merge":
      case "mergeAndClose":
        return "MERGING";
      case "remove":
      case "cleanup":
        return "CLEANUP";
      default:
        // For unknown operations, fall through to state-based derivation
        break;
    }
  }

  // Agent actively running takes priority over terminal lifecycle
  // (agent may be running even if lifecycle was incorrectly set)
  if (state.agent === "running") return "RUNNING";

  // Lifecycle terminal states
  if (state.lifecycle === "removed") return "REMOVED";

  // Linear status terminal states
  if (state.linearStatus === "done") return "DONE";
  if (state.linearStatus === "cancelled") return "CANCELLED";

  // Lifecycle non-terminal
  if (state.lifecycle === "spawning") return "SPAWNING";
  if (state.lifecycle === "pending") return "PENDING";

  // Git operations in progress (without currentOperation — e.g. stuck state)
  if (state.git.op === "rebasing") return "REBASING";
  if (state.git.op === "merging") return "MERGING";

  // Agent stopped but lifecycle active
  return "EXITED";
}

/**
 * Bootstrap AgentState from a legacy AgentData record.
 * Used when loading agents that were saved before the aggregate refactor.
 */
export function stateFromLegacy(agent: AgentData): AgentState {
  const state = defaultAgentState(agent.branch);

  // Map legacy status to state axes
  switch (agent.status) {
    case "PENDING":
      state.lifecycle = "pending";
      state.agent = "stopped";
      state.linearStatus = "unstarted";
      break;

    case "SPAWNING":
      state.lifecycle = "spawning";
      state.agent = "stopped";
      state.linearStatus = "in_progress";
      break;

    case "RUNNING":
      state.lifecycle = "active";
      state.agent = "running";
      state.linearStatus = "in_progress";
      break;

    case "EXITED":
    case "WAITING":
      state.lifecycle = "active";
      state.agent = "stopped";
      state.linearStatus = "in_progress";
      break;

    case "PREVIEW":
    case "IN_REVIEW":
      state.lifecycle = "active";
      state.agent = "stopped";
      state.linearStatus = "in_progress";
      break;

    case "REBASING":
      state.lifecycle = "active";
      state.agent = "stopped";
      state.linearStatus = "in_progress";
      state.git.op = "rebasing";
      break;

    case "MERGING":
      state.lifecycle = "active";
      state.agent = "stopped";
      state.linearStatus = "in_progress";
      state.git.op = "merging";
      break;

    case "DONE":
      state.lifecycle = "active";
      state.agent = "stopped";
      state.linearStatus = "done";
      break;

    case "CANCELLED":
      state.lifecycle = "active";
      state.agent = "stopped";
      state.linearStatus = "cancelled";
      break;

    case "CLEANUP":
    case "REMOVED":
      state.lifecycle = "removed";
      state.agent = "stopped";
      break;
  }

  // Container: we can't know for sure without checking Docker,
  // so default to "missing" for non-running states, "running" for active+running
  if (state.agent === "running" || (state.lifecycle === "active" && agent.containerName)) {
    state.container = "running"; // optimistic — will be corrected by refreshAgent
  } else {
    state.container = agent.containerName ? "stopped" : "missing";
  }

  // Git branch
  state.git.branch = agent.branch || "";

  return state;
}
