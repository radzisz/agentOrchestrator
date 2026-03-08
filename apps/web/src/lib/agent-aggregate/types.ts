// ---------------------------------------------------------------------------
// Agent Aggregate — State Model
// ---------------------------------------------------------------------------

import type * as store from "@/lib/store";

// ---------------------------------------------------------------------------
// Aggregate Context — passed to extracted operation functions
// ---------------------------------------------------------------------------

export interface AggregateContext {
  readonly issueId: string;
  readonly projectPath: string;
  readonly projectName: string;
  agent: store.AgentData;
  state: AgentState;
  persist(): void;
  opLog(opName: string, msg: string): void;
  makeOnExitedCallback(): () => void;
  setLifecycle(value: AgentState["lifecycle"]): void;
  getDefaultBranch(): Promise<string>;
  beginTransition(to: "running" | "stopped"): void;
  endTransition(): void;
}

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

export type TrackerStatusValue = "unstarted" | "in_progress" | "done" | "cancelled";

export interface AgentTransition {
  to: "running" | "stopped";
  startedAt: string;
}

export interface AgentState {
  agent: "running" | "stopped";
  container: "running" | "stopped" | "missing";
  lifecycle: "pending" | "spawning" | "active" | "removed";
  transition?: AgentTransition | null;
  trackerStatus: TrackerStatusValue;
  /** @deprecated Use trackerStatus instead. Kept for backward compatibility with persisted data. */
  linearStatus: TrackerStatusValue;
  git: GitState;
  services: Record<string, ServiceState>;
}

/** Deep-readonly version of AgentState — returned by aggregate.snapshot. */
export type ReadonlyAgentState = Readonly<{
  agent: AgentState["agent"];
  container: AgentState["container"];
  lifecycle: AgentState["lifecycle"];
  transition: Readonly<AgentTransition> | null;
  trackerStatus: TrackerStatusValue;
  linearStatus: TrackerStatusValue;
  git: Readonly<GitState>;
  services: Readonly<Record<string, Readonly<ServiceState>>>;
}>;

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
  // Transition in progress — agent is between states
  if (state.transition) {
    if (state.transition.to === "running") return { status: "starting" };
    if (state.transition.to === "stopped") return { status: "closing" };
  }

  // Starting: spawn or wake in progress (fallback for ops without transition)
  if (op && (op.name === "spawn" || op.name === "wake" || op.name === "restore")) {
    return { status: "starting" };
  }

  // Closing: merge, reject, or remove in progress
  if (op && (op.name === "mergeAndClose" || op.name === "reject" || op.name === "remove")) {
    return { status: "closing" };
  }

  // Running: agent process alive
  if (state.agent === "running") {
    return { status: "running" };
  }

  // Closed: lifecycle removed, or tracker closed AND no active resources
  if (state.lifecycle === "removed") {
    return { status: "closed" };
  }
  if (
    (state.trackerStatus === "done" || state.trackerStatus === "cancelled") &&
    state.container !== "running" && state.agent === "stopped"
  ) {
    return { status: "closed" };
  }

  // Awaiting: agent stopped but lifecycle active (or tracker closed with resources still up)
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
    trackerStatus: "unstarted",
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
