// ---------------------------------------------------------------------------
// Agent Aggregate — State Model
// ---------------------------------------------------------------------------

export interface GitState {
  op: "idle" | "rebasing" | "merging";
  branch: string;
  dirty: boolean;
  aheadBy: number;
  behindBy: number;
  merged: boolean;
  lastCommit: { sha: string; message: string; author: string; date: string } | null;
}

export interface ServiceState {
  status: "starting" | "running" | "stopped";
  error?: string;
}

export interface AgentState {
  agent: "running" | "stopped";
  container: "running" | "stopped" | "missing";
  lifecycle: "pending" | "spawning" | "active" | "removed";
  linearStatus: "unstarted" | "in_progress" | "done" | "cancelled";
  git: GitState;
  services: Record<string, ServiceState>;
}

export interface CurrentOperation {
  name: string;
  startedAt: string;
  progress?: string;
}

// ---------------------------------------------------------------------------
// UI Status — the single source of truth for what the UI shows
// ---------------------------------------------------------------------------

export type UiStatus = "starting" | "running" | "awaiting" | "closing" | "closed";
export type AwaitingReason = "completed" | "error" | "conflict";

export interface UiState {
  status: UiStatus;
  reason?: AwaitingReason;
}

export function deriveUiStatus(
  state: AgentState,
  op: CurrentOperation | null,
): UiState {
  // Starting: spawn or wake in progress
  if (op && (op.name === "spawn" || op.name === "wake" || op.name === "restore")) {
    return { status: "starting" };
  }

  // Closing: merge, reject, or remove in progress
  if (op && (op.name === "mergeAndClose" || op.name === "reject" || op.name === "remove")) {
    return { status: "closing" };
  }

  // Running: agent process alive — takes priority over terminal lifecycle
  // (agent may be running even if lifecycle was incorrectly set to removed)
  if (state.agent === "running") {
    return { status: "running" };
  }

  // Closed: terminal states
  if (
    state.linearStatus === "done" ||
    state.linearStatus === "cancelled" ||
    state.lifecycle === "removed"
  ) {
    return { status: "closed" };
  }

  // Awaiting: agent stopped but lifecycle active
  if (state.lifecycle === "active" || state.lifecycle === "spawning") {
    if (state.git.op === "rebasing") {
      return { status: "awaiting", reason: "conflict" };
    }
    return { status: "awaiting", reason: "completed" };
  }

  // Fallback — pending lifecycle = starting
  return { status: "starting" };
}

export function defaultAgentState(branch?: string): AgentState {
  return {
    agent: "stopped",
    container: "missing",
    lifecycle: "pending",
    linearStatus: "unstarted",
    git: {
      op: "idle",
      branch: branch || "",
      dirty: false,
      aheadBy: 0,
      behindBy: 0,
      merged: false,
      lastCommit: null,
    },
    services: {},
  };
}
