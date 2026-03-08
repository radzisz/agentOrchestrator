"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  GitMerge, Ban, Trash2, RotateCcw, AlertTriangle,
  Eye, MessageSquare, CheckCircle, Square,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitStateData {
  op: string;
  branch: string;
  dirty: boolean;
  aheadBy: number;
  behindBy: number;
  merged: boolean;
}

export interface AgentTransitionData {
  to: "running" | "stopped";
  startedAt: string;
}

export interface AgentStateData {
  agent: string;
  container: string;
  lifecycle: string;
  transition?: AgentTransitionData | null;
  trackerStatus?: string;
  /** @deprecated Use trackerStatus */
  linearStatus: string;
  git: GitStateData;
  services: Record<string, { status: string; error?: string }>;
}

// ---------------------------------------------------------------------------
// State Card (compact key-value display)
// ---------------------------------------------------------------------------

const stateColors: Record<string, string> = {
  running: "text-green-500",
  stopped: "text-muted-foreground",
  missing: "text-muted-foreground",
  active: "text-green-500",
  pending: "text-yellow-500",
  spawning: "text-yellow-500",
  removed: "text-muted-foreground",
  in_progress: "text-blue-500",
  done: "text-green-500",
  cancelled: "text-red-500",
  unstarted: "text-muted-foreground",
  rebasing: "text-yellow-500",
  merging: "text-purple-500",
  starting: "text-yellow-500",
  stopping: "text-yellow-500",
};

function StateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono font-medium ${stateColors[value] || "text-foreground"}`}>{value}</span>
    </div>
  );
}

export function StateCard({ state, currentOp, issueId, projectName }: { state: AgentStateData; currentOp?: { name: string; progress?: string } | null; issueId: string; projectName: string }) {
  const git = state.git;

  const agentDisplay = state.transition
    ? state.transition.to === "running" ? "starting" : "stopping"
    : state.agent;

  return (
    <div className="space-y-1">
      <StateRow label="Agent" value={agentDisplay} />
      <StateRow label="Container" value={state.container} />
      <StateRow label="Lifecycle" value={state.lifecycle} />
      <StateRow label="Tracker" value={state.trackerStatus || "unknown"} />

      <div className="pt-1 border-t border-border mt-1 space-y-1">
        {git.op !== "idle" && <StateRow label="Git op" value={git.op} />}
        <div className="flex items-center justify-between text-xs gap-3">
          <span className="text-muted-foreground">Changes</span>
          <span className={`font-mono font-medium ${git.dirty ? "text-yellow-500" : "text-muted-foreground"}`}>
            {git.dirty ? "uncommitted" : "clean"}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs gap-3">
          <span className="text-muted-foreground">Branch</span>
          <span className="font-mono font-medium">
            {git.merged
              ? <span className="text-green-500">merged</span>
              : <>
                  <span className={git.aheadBy > 0 ? "text-blue-400" : "text-muted-foreground/50"}>
                    +{git.aheadBy}
                  </span>
                  <span className="text-muted-foreground/30 mx-0.5">/</span>
                  <span className={git.behindBy > 0 ? "text-orange-400" : "text-muted-foreground/50"}>
                    −{git.behindBy}
                  </span>
                </>
            }
          </span>
        </div>
      </div>

      {currentOp && (
        <div className="pt-1 border-t border-border mt-1">
          <StateRow label="Operation" value={currentOp.name} />
          {currentOp.progress && (
            <p className="text-[10px] text-muted-foreground mt-0.5">{currentOp.progress}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next Steps — user-facing guidance + actions
//
// Each item has:
//   - condition: when to show
//   - type: "info" (text only), "warning" (yellow), "action" (button)
//   - For actions: button label, variant, onClick
// ---------------------------------------------------------------------------

interface NextStep {
  key: string;
  type: "info" | "warning" | "action";
  icon: React.ReactNode;
  text: string;
  buttonLabel?: string;
  buttonVariant?: "default" | "destructive" | "outline";
  onClick?: () => Promise<void> | void;
  showLogs?: boolean; // default true — set false for actions like "Review code"
}

// ---------------------------------------------------------------------------
// Next steps decision table (evaluated top-to-bottom, early returns marked ←)
//
// | # | Condition                                        | Type    | Text / Action                           |
// |---|--------------------------------------------------|---------|-----------------------------------------|
// | 1 | currentOp !== null                               | info    | Operation in progress: {name}         ← |
// | 2 | agent === "running"                              | info    | Agent is working. Use chat.           ← |
// | 3 | git.op === "rebasing"                            | warning | Rebase conflict.                      ← |
// | 4 | lifecycle === "removed"                          | info    | Cleaned up. (no actions)              ← |
// |4a | └─ container !== "missing"                       | action  | Orphan container → Remove container     |
// | 5 | linearStatus done|cancelled (lifecycle≠removed)  | action  | Issue closed → Remove files           ← |
// | 6 | lifecycle === "pending"                          | info    | Op in progress: waiting for spawn     ← |
// |   | ── Below: lifecycle=active, agent=stopped ──     |         |                                         |
// | 7 | git.dirty                                        | warning | Uncommitted changes.                    |
// | 8 | git.merged                                       | info+   | Merged → Close issue & clean up       ← |
// | 9 | git.behindBy > 0                                 | action  | Behind main → Rebase                    |
// |10 | git.aheadBy > 0 && !dirty                        | action  | Commits → Review, Merge, Reject         |
// |11 | aheadBy === 0 && !dirty                          | info    | No changes. Send instructions.          |
// |12 | services all stopped                             | action  | Start services                          |
// ---------------------------------------------------------------------------

function deriveNextSteps(
  state: AgentStateData,
  currentOp: { name: string } | null | undefined,
  issueId: string,
  projectName: string,
): NextStep[] {
  // ── Transition in progress ──
  if (state.transition) {
    const isStarting = state.transition.to === "running";
    return [{
      key: "transition",
      type: "info" as const,
      icon: <RotateCcw className="h-3.5 w-3.5 animate-spin" />,
      text: isStarting ? "Agent is starting..." : "Agent is stopping...",
    }];
  }

  // ── Operation in progress ──
  if (currentOp) {
    const opLabels: Record<string, string> = {
      mergeAndClose: "Merging and closing",
      reject: "Rejecting",
      remove: "Removing agent",
      restore: "Restoring agent",
      spawn: "Spawning agent",
      wake: "Waking agent",
      rebase: "Rebasing",
    };
    const label = opLabels[currentOp.name] || `Operation: ${currentOp.name}`;
    const progress = (currentOp as { progress?: string }).progress;
    const opSteps: NextStep[] = [{
      key: "in-progress",
      type: "info",
      icon: <RotateCcw className="h-3.5 w-3.5 animate-spin" />,
      text: progress ? `${label} — ${progress}` : label,
    }];
    // Allow cancelling spawn/restore/wake operations
    if (["spawn", "restore", "wake"].includes(currentOp.name)) {
      opSteps.push({
        key: "cancel-op",
        type: "action",
        icon: <Ban className="h-3.5 w-3.5" />,
        text: "Cancel and clean up.",
        buttonLabel: "Cancel",
        buttonVariant: "destructive",
        onClick: () => { window.dispatchEvent(new Event("open-reject-dialog")); },
      });
    }
    return opSteps;
  }

  const steps: NextStep[] = [];
  const git = state.git;

  // ── Agent is running ──
  if (state.agent === "running") {
    steps.push({
      key: "running",
      type: "info",
      icon: <span className="relative flex h-3 w-3"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" /><span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" /></span>,
      text: "Agent is working. Use chat to communicate.",
    });
    steps.push({
      key: "stop",
      type: "action",
      icon: <Square className="h-3.5 w-3.5" />,
      text: "Stop agent process.",
      buttonLabel: "Stop",
      buttonVariant: "destructive",
      onClick: async () => {
        await fetch(`/api/agents/${issueId}/stop`, { method: "POST" });
      },
    });
    return steps;
  }

  // ── Conflict ──
  if (git.op === "rebasing") {
    steps.push({
      key: "conflict",
      type: "warning",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      text: "Rebase conflict. Resolve manually in the agent's working directory, or send a message to let the agent try.",
    });
    return steps;
  }

  // ── Fully cleaned up (lifecycle=removed means files are gone) ──
  if (state.lifecycle === "removed") {
    const ts = state.trackerStatus;
    const label = ts === "done" ? "Issue completed and cleaned up."
      : ts === "cancelled" ? "Issue cancelled and cleaned up."
      : "Agent removed.";
    steps.push({
      key: "removed-info",
      type: "info",
      icon: <CheckCircle className="h-3.5 w-3.5" />,
      text: label,
    });
    // Restore action
    steps.push({
      key: "restore",
      type: "action",
      icon: <RotateCcw className="h-3.5 w-3.5" />,
      text: "Restore agent from git history.",
      buttonLabel: "Restore",
      onClick: () => { window.dispatchEvent(new Event("open-restore-dialog")); },
    });
    // Edge case: container still exists even though lifecycle says removed
    if (state.container !== "missing") {
      steps.push({
        key: "orphan-container",
        type: "action",
        icon: <Trash2 className="h-3.5 w-3.5" />,
        text: "Orphan container still exists.",
        buttonLabel: "Remove container",
        buttonVariant: "destructive",
        onClick: () => fetch(`/api/agents/${issueId}`, { method: "DELETE" }).then(() => { window.dispatchEvent(new Event("agent-state-changed")); }),
      });
    }
    return steps;
  }

  // ── Issue closed in Linear but files still exist (lifecycle !== removed) ──
  const trackerSt = state.trackerStatus;
  if (trackerSt === "done" || trackerSt === "cancelled") {
    steps.push({
      key: "closed-info",
      type: "info",
      icon: <CheckCircle className="h-3.5 w-3.5" />,
      text: trackerSt === "done" ? "Issue completed." : "Issue cancelled.",
    });
    steps.push({
      key: "cleanup",
      type: "action",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      text: "Remove container, local clone and volumes.",
      buttonLabel: "Remove files",
      buttonVariant: "destructive",
      onClick: () => { window.dispatchEvent(new Event("open-remove-dialog")); },
    });
    return steps;
  }

  // ── Pending / Spawning (not yet ready) ──
  if (state.lifecycle === "pending" || state.lifecycle === "spawning") {
    return [
      {
        key: "pending",
        type: "info" as const,
        icon: <RotateCcw className="h-3.5 w-3.5 animate-spin" />,
        text: state.lifecycle === "spawning" ? "Spawning agent..." : "Operation in progress: waiting for spawn",
      },
      {
        key: "cancel-spawn",
        type: "action" as const,
        icon: <Ban className="h-3.5 w-3.5" />,
        text: "Cancel and clean up.",
        buttonLabel: "Cancel",
        buttonVariant: "destructive" as const,
        onClick: () => { window.dispatchEvent(new Event("open-reject-dialog")); },
      },
    ];
  }

  // ── Awaiting (agent stopped, lifecycle active) ──

  // Uncommitted changes → tell agent to commit & push
  if (git.dirty) {
    steps.push({
      key: "dirty",
      type: "warning",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      text: "Agent has uncommitted changes.",
      buttonLabel: "Commit & push",
      buttonVariant: "outline",
      showLogs: false,
      onClick: async () => {
        await fetch(`/api/agents/${issueId}/wake`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Commit all your changes and push to remote. Do not start any new work." }),
        });
      },
    });
  }

  // Already merged → close issue & clean up (no merge/reject/rebase needed)
  if (git.merged) {
    steps.push({
      key: "merged",
      type: "info",
      icon: <CheckCircle className="h-3.5 w-3.5 text-green-500" />,
      text: "Branch is already merged into main.",
    });
    steps.push({
      key: "close-issue",
      type: "action",
      icon: <CheckCircle className="h-3.5 w-3.5" />,
      text: "Close the Linear issue and remove agent files.",
      buttonLabel: "Close issue & clean up",
      buttonVariant: "default",
      onClick: () => fetch(`/api/agents/${issueId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "merge", cleanup: true, closeIssue: true, skipMerge: true }),
      }).then(() => { window.location.href = `/projects/${projectName}`; }),
    });
    return steps;
  }

  // Not merged from here on

  // Behind main → rebase
  if (git.behindBy > 0) {
    steps.push({
      key: "behind",
      type: "action",
      icon: <RotateCcw className="h-3.5 w-3.5" />,
      text: `Branch is ${git.behindBy} commit${git.behindBy > 1 ? "s" : ""} behind main.`,
      buttonLabel: "Rebase",
      buttonVariant: "outline",
      onClick: () => fetch(`/api/agents/${issueId}/rebase`, { method: "POST" }).then(() => { window.dispatchEvent(new Event("agent-state-changed")); }),
    });
  }

  // Has commits, not dirty → review & decide
  if (git.aheadBy > 0 && !git.dirty) {
    if (git.behindBy === 0) {
      steps.push({
        key: "review",
        type: "action",
        icon: <Eye className="h-3.5 w-3.5" />,
        text: `${git.aheadBy} commit${git.aheadBy > 1 ? "s" : ""} ready.`,
        buttonLabel: "Review code",
        buttonVariant: "outline",
        showLogs: false,
        onClick: () => {
          window.dispatchEvent(new Event("show-code"));
        },
      });
      steps.push({
        key: "merge",
        type: "action",
        icon: <GitMerge className="h-3.5 w-3.5" />,
        text: "Merge into main and close issue.",
        buttonLabel: "Merge & close",
        buttonVariant: "default",
        onClick: () => { window.dispatchEvent(new Event("open-merge-dialog")); },
      });
    }
  }

  // No work done, no dirty, not merged — agent stopped without producing anything
  if (git.aheadBy === 0 && !git.dirty) {
    steps.push({
      key: "no-work",
      type: "info",
      icon: <MessageSquare className="h-3.5 w-3.5" />,
      text: "No changes. Send new instructions or cancel.",
    });
    steps.push({
      key: "cancel",
      type: "action",
      icon: <Ban className="h-3.5 w-3.5" />,
      text: "Cancel issue and clean up.",
      buttonLabel: "Cancel",
      buttonVariant: "destructive",
      onClick: () => { window.dispatchEvent(new Event("open-reject-dialog")); },
    });
  }

  // Services are managed by ServicesBar — no need to duplicate here

  return steps;
}

// ---------------------------------------------------------------------------
// Next Steps Component
// ---------------------------------------------------------------------------

export function NextSteps({ state, currentOp, issueId, projectName }: {
  state: AgentStateData;
  currentOp?: { name: string; progress?: string } | null;
  issueId: string;
  projectName: string;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const steps = deriveNextSteps(state, currentOp, issueId, projectName);

  if (steps.length === 0) return null;

  async function run(fn?: () => Promise<void> | void, key?: string, showLogs = true) {
    if (!fn) return;
    setLoading(key || "action");
    if (showLogs) window.dispatchEvent(new Event("show-logs"));
    try {
      await fn();
    } finally {
      setLoading(null);
    }
  }

  const canReject = state.git.aheadBy > 0 && !state.git.dirty;

  return (
    <div className="space-y-1">
      {steps.map((step, i) => (
        <div
          key={step.key}
          className={`flex items-center gap-2 text-xs rounded-md px-2 py-1 ${
            step.type === "warning"
              ? "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
              : step.type === "info"
                ? "text-muted-foreground"
                : ""
          }`}
        >
          <span className="shrink-0">{step.icon}</span>
          <span>{step.text}</span>
          {step.buttonLabel && (
            <Button
              variant={step.buttonVariant || "outline"}
              size="sm"
              className="shrink-0 h-5 text-[11px] px-2"
              disabled={loading !== null}
              onClick={() => run(step.onClick, step.key, step.showLogs !== false)}
            >
              {loading === step.key && (
                <span className="animate-spin h-3 w-3 border-2 border-current border-t-transparent rounded-full mr-1.5" />
              )}
              {step.buttonLabel}
            </Button>
          )}
          {/* Reject link — right side of first row */}
          {i === 0 && canReject && (
            <>
              <span className="flex-1" />
              <button
                className="shrink-0 text-[11px] text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                disabled={loading !== null}
                onClick={() => run(() => { window.dispatchEvent(new Event("open-reject-dialog")); }, "reject")}
              >
                Reject & discard
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
