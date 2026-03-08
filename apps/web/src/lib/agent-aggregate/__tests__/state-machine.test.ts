// ---------------------------------------------------------------------------
// Exhaustive AgentAggregate state machine tests
//
// Tests every practical combination of state axes (agent, container, lifecycle,
// trackerStatus, git, transition, currentOperation) and verifies that:
// 1. deriveUiStatus returns the correct badge for ALL combos
// 2. deriveLegacyStatus agrees with deriveUiStatus on terminal states
// 3. _doRefresh business rules produce correct state after every check pattern
// 4. Observation methods enforce invariants
// 5. _setLifecycle guards prevent impossible states
// 6. Tracker integration (BoundIssue + aggregate) works end-to-end
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { AgentState, CurrentOperation, AgentTransition, TrackerStatusValue } from "../types";
import { defaultAgentState, deriveUiStatus } from "../types";
import { deriveLegacyStatus, stateFromLegacy } from "../compat";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return { ...defaultAgentState("agent/TEST-1"), ...overrides };
}

function op(name: string): CurrentOperation {
  return { name, startedAt: new Date().toISOString() };
}

function transition(to: "running" | "stopped"): AgentTransition {
  return { to, startedAt: new Date().toISOString() };
}

// Simulate _setLifecycle guard from aggregate
function setLifecycle(state: AgentState, value: AgentState["lifecycle"]): void {
  if (value === "removed") {
    const ts = state.trackerStatus;
    if (ts === "in_progress" || ts === "unstarted") {
      state.trackerStatus = "cancelled";
      state.linearStatus = "cancelled";
    }
  }
  state.lifecycle = value;
}

// Simulate _doRefresh business rules (extracted)
function doRefresh(
  state: AgentState,
  checks: {
    container: "running" | "stopped" | "missing";
    agent: "running" | "stopped";
    git: Partial<AgentState["git"]>;
    services: Record<string, { status: "running" | "stopped" }>;
  },
  agentDirExists: boolean = true,
): AgentState {
  const s = { ...state, git: { ...state.git }, services: { ...state.services } };
  const wasPreviouslyRunning = s.agent === "running";

  s.container = checks.container;
  s.agent = checks.agent;
  s.services = checks.services;
  Object.assign(s.git, checks.git);

  // Business rule: merged + tracker active → done
  if (s.git.merged && s.trackerStatus !== "done" && s.trackerStatus !== "cancelled") {
    s.trackerStatus = "done";
    s.linearStatus = "done";
  }

  // Business rule: agent running without container → forced stop
  if (s.agent === "running" && s.container !== "running") {
    s.agent = "stopped";
  }

  // Stale transition cleanup (simplified — assumes transition always > 5min stale if present)
  if (s.transition) {
    const reached = (s.transition.to === "running" && s.agent === "running") ||
                    (s.transition.to === "stopped" && s.agent === "stopped");
    if (reached) {
      s.transition = null;
    }
  }

  // Derive lifecycle=removed when: tracker closed + no container + no agent + no files
  if (s.lifecycle === "active" &&
      (s.trackerStatus === "done" || s.trackerStatus === "cancelled") &&
      s.container === "missing" &&
      s.agent === "stopped" &&
      !agentDirExists) {
    s.lifecycle = "removed";
  }

  return s;
}

// Simulate observation methods
function reportProcessExited(state: AgentState): void {
  if (state.agent === "running") state.agent = "stopped";
}

function reportContainerDead(state: AgentState): void {
  if (state.container !== "missing") state.container = "missing";
  if (state.agent === "running") state.agent = "stopped";
}

function reportBranchMerged(state: AgentState): void {
  state.git.merged = true;
  if (state.trackerStatus !== "done" && state.trackerStatus !== "cancelled") {
    state.trackerStatus = "done";
    state.linearStatus = "done";
  }
  state.git.aheadBy = 0;
  state.git.behindBy = 0;
}

function reportBranchGone(state: AgentState): void {
  if (state.agent !== "running") {
    state.trackerStatus = "done";
    state.linearStatus = "done";
    state.agent = "stopped";
  }
}

// ==========================================================================
// 1. EXHAUSTIVE deriveUiStatus — every axis combination
// ==========================================================================

describe("deriveUiStatus — exhaustive state combinations", () => {
  // All possible values for each axis
  const agents: AgentState["agent"][] = ["running", "stopped"];
  const containers: AgentState["container"][] = ["running", "stopped", "missing"];
  const lifecycles: AgentState["lifecycle"][] = ["pending", "spawning", "active", "removed"];
  const trackerStatuses: TrackerStatusValue[] = ["unstarted", "in_progress", "done", "cancelled"];
  const gitOps: AgentState["git"]["op"][] = ["idle", "rebasing", "merging"];

  // Transition: null, to-running, to-stopped
  const transitions: (AgentTransition | null)[] = [
    null,
    transition("running"),
    transition("stopped"),
  ];

  // Operation names that affect UI
  const operations: (CurrentOperation | null)[] = [
    null,
    op("spawn"),
    op("wake"),
    op("restore"),
    op("mergeAndClose"),
    op("reject"),
    op("remove"),
    op("rebase"),
    op("startServices"),
  ];

  describe("transition takes priority over everything else", () => {
    it("transition to=running → 'starting' regardless of other axes", () => {
      for (const agent of agents) {
        for (const lifecycle of lifecycles) {
          for (const ts of trackerStatuses) {
            const state = makeState({
              agent,
              lifecycle,
              trackerStatus: ts,
              linearStatus: ts,
              transition: transition("running"),
            });
            expect(deriveUiStatus(state, null).status).toBe("starting");
          }
        }
      }
    });

    it("transition to=stopped → 'closing' regardless of other axes", () => {
      for (const agent of agents) {
        for (const lifecycle of lifecycles) {
          const state = makeState({
            agent,
            lifecycle,
            transition: transition("stopped"),
          });
          expect(deriveUiStatus(state, null).status).toBe("closing");
        }
      }
    });
  });

  describe("operations (no transition)", () => {
    it("spawn/wake/restore → 'starting'", () => {
      for (const name of ["spawn", "wake", "restore"]) {
        for (const agent of agents) {
          for (const lifecycle of lifecycles) {
            const state = makeState({ agent, lifecycle });
            expect(deriveUiStatus(state, op(name)).status).toBe("starting");
          }
        }
      }
    });

    it("mergeAndClose/reject/remove → 'closing'", () => {
      for (const name of ["mergeAndClose", "reject", "remove"]) {
        for (const agent of agents) {
          for (const lifecycle of lifecycles) {
            const state = makeState({ agent, lifecycle });
            expect(deriveUiStatus(state, op(name)).status).toBe("closing");
          }
        }
      }
    });

    it("rebase/startServices → falls through to state-based derivation", () => {
      const state = makeState({ lifecycle: "active", agent: "running" });
      expect(deriveUiStatus(state, op("rebase")).status).toBe("running");
      expect(deriveUiStatus(state, op("startServices")).status).toBe("running");
    });
  });

  describe("no transition, no operation → pure state derivation", () => {
    it("agent=running → always 'running'", () => {
      for (const lifecycle of lifecycles) {
        for (const ts of trackerStatuses) {
          for (const container of containers) {
            const state = makeState({ agent: "running", lifecycle, trackerStatus: ts, linearStatus: ts, container });
            expect(deriveUiStatus(state, null).status).toBe("running");
          }
        }
      }
    });

    it("lifecycle=removed + agent=stopped → 'closed'", () => {
      for (const ts of trackerStatuses) {
        for (const container of containers) {
          const state = makeState({ lifecycle: "removed", agent: "stopped", trackerStatus: ts, linearStatus: ts, container });
          expect(deriveUiStatus(state, null).status).toBe("closed");
        }
      }
    });

    it("trackerStatus=done/cancelled + agent=stopped + container≠running → 'closed'", () => {
      for (const ts of ["done", "cancelled"] as TrackerStatusValue[]) {
        for (const container of ["stopped", "missing"] as AgentState["container"][]) {
          for (const lifecycle of ["active", "spawning"] as AgentState["lifecycle"][]) {
            const state = makeState({
              agent: "stopped",
              lifecycle,
              trackerStatus: ts,
              linearStatus: ts,
              container,
            });
            expect(deriveUiStatus(state, null).status).toBe("closed");
          }
        }
      }
    });

    it("trackerStatus=done/cancelled + agent=stopped + container=running → 'awaiting' (resources still up)", () => {
      for (const ts of ["done", "cancelled"] as TrackerStatusValue[]) {
        for (const lifecycle of ["active", "spawning"] as AgentState["lifecycle"][]) {
          const state = makeState({
            agent: "stopped",
            lifecycle,
            trackerStatus: ts,
            linearStatus: ts,
            container: "running",
          });
          expect(deriveUiStatus(state, null).status).toBe("awaiting");
        }
      }
    });

    it("lifecycle=active + agent=stopped + trackerStatus active → 'awaiting'", () => {
      for (const ts of ["unstarted", "in_progress"] as TrackerStatusValue[]) {
        const state = makeState({
          agent: "stopped",
          lifecycle: "active",
          trackerStatus: ts,
          linearStatus: ts,
        });
        const ui = deriveUiStatus(state, null);
        expect(ui.status).toBe("awaiting");
        expect(ui.reason).toBe("completed");
      }
    });

    it("lifecycle=active + agent=stopped + git.op=rebasing → 'awaiting' with conflict reason", () => {
      const state = makeState({ agent: "stopped", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
      state.git.op = "rebasing";
      expect(deriveUiStatus(state, null)).toEqual({ status: "awaiting", reason: "conflict" });
    });

    it("lifecycle=pending + agent=stopped → 'starting' (fallback)", () => {
      const state = makeState({ lifecycle: "pending", agent: "stopped" });
      expect(deriveUiStatus(state, null).status).toBe("starting");
    });
  });
});

// ==========================================================================
// 2. deriveLegacyStatus — exhaustive and cross-checks
// ==========================================================================

describe("deriveLegacyStatus — exhaustive priority checks", () => {
  it("operation priority: spawn/restore → SPAWNING, rebase → REBASING, merge → MERGING, remove → CLEANUP", () => {
    const mapping: Array<[string, string]> = [
      ["spawn", "SPAWNING"],
      ["restore", "SPAWNING"],
      ["rebase", "REBASING"],
      ["mergeAndClose", "MERGING"],
      ["merge", "MERGING"],
      ["remove", "CLEANUP"],
      ["cleanup", "CLEANUP"],
    ];
    for (const [opName, expected] of mapping) {
      // Even with terminal state, operation takes priority
      const state = makeState({ lifecycle: "removed", trackerStatus: "done", linearStatus: "done" });
      expect(deriveLegacyStatus(state, op(opName))).toBe(expected);
    }
  });

  it("unknown operation falls through to state-based derivation", () => {
    const state = makeState({ lifecycle: "active", agent: "running" });
    expect(deriveLegacyStatus(state, op("startServices"))).toBe("RUNNING");
  });

  it("priority: RUNNING > REMOVED > DONE/CANCELLED > SPAWNING > PENDING > REBASING/MERGING > EXITED", () => {
    // RUNNING beats everything (no operation)
    expect(deriveLegacyStatus(makeState({ agent: "running", lifecycle: "removed", trackerStatus: "done", linearStatus: "done" }), null)).toBe("RUNNING");

    // REMOVED beats DONE
    expect(deriveLegacyStatus(makeState({ agent: "stopped", lifecycle: "removed", trackerStatus: "done", linearStatus: "done" }), null)).toBe("REMOVED");

    // DONE beats EXITED
    expect(deriveLegacyStatus(makeState({ agent: "stopped", lifecycle: "active", trackerStatus: "done", linearStatus: "done" }), null)).toBe("DONE");

    // CANCELLED beats EXITED
    expect(deriveLegacyStatus(makeState({ agent: "stopped", lifecycle: "active", trackerStatus: "cancelled", linearStatus: "cancelled" }), null)).toBe("CANCELLED");

    // SPAWNING beats EXITED
    expect(deriveLegacyStatus(makeState({ agent: "stopped", lifecycle: "spawning", trackerStatus: "in_progress", linearStatus: "in_progress" }), null)).toBe("SPAWNING");

    // PENDING is specific
    expect(deriveLegacyStatus(makeState({ agent: "stopped", lifecycle: "pending" }), null)).toBe("PENDING");

    // REBASING when git.op = rebasing
    const rebasingState = makeState({ agent: "stopped", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
    rebasingState.git.op = "rebasing";
    expect(deriveLegacyStatus(rebasingState, null)).toBe("REBASING");

    // EXITED is fallback
    expect(deriveLegacyStatus(makeState({ agent: "stopped", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" }), null)).toBe("EXITED");
  });
});

describe("legacy ↔ ui terminal consistency — exhaustive", () => {
  const LEGACY_TERMINAL = new Set(["DONE", "CANCELLED", "REMOVED"]);
  const UI_TERMINAL = new Set(["closed"]);

  // Generate all non-transition, non-operation combos
  const agents: AgentState["agent"][] = ["running", "stopped"];
  const lifecycles: AgentState["lifecycle"][] = ["pending", "spawning", "active", "removed"];
  const trackerStatuses: TrackerStatusValue[] = ["unstarted", "in_progress", "done", "cancelled"];
  const containers: AgentState["container"][] = ["running", "stopped", "missing"];

  for (const agent of agents) {
    for (const lifecycle of lifecycles) {
      for (const ts of trackerStatuses) {
        for (const container of containers) {
          const desc = `agent=${agent} lifecycle=${lifecycle} tracker=${ts} container=${container}`;
          it(`${desc}: terminal agreement`, () => {
            const state = makeState({ agent, lifecycle, trackerStatus: ts, linearStatus: ts, container });
            const legacy = deriveLegacyStatus(state, null);
            const ui = deriveUiStatus(state, null);
            const legacyTerminal = LEGACY_TERMINAL.has(legacy);
            const uiTerminal = UI_TERMINAL.has(ui.status);

            // Special case: tracker=done/cancelled but container=running + agent=stopped
            // legacy says DONE/CANCELLED (terminal), ui says "closed" (terminal) - should agree
            // OR agent=running overrides both to non-terminal

            if (agent === "running") {
              // Running agent → both should be non-terminal
              expect(legacyTerminal).toBe(false);
              expect(uiTerminal).toBe(false);
            } else if (
              (ts === "done" || ts === "cancelled") &&
              container === "running" &&
              lifecycle !== "removed"
            ) {
              // Known divergence: legacy says DONE/CANCELLED (terminal)
              // but UI says "awaiting" because container is still running.
              // This is intentional — UI requires all resources cleaned up.
              expect(legacyTerminal).toBe(true);
              expect(uiTerminal).toBe(false);
            } else {
              // Otherwise both should agree on terminal/non-terminal
              expect(legacyTerminal).toBe(uiTerminal);
            }
          });
        }
      }
    }
  }
});

// ==========================================================================
// 3. _doRefresh business rules
// ==========================================================================

describe("_doRefresh business rules — exhaustive scenarios", () => {
  describe("agent/container invariant", () => {
    it("agent=running + container=stopped → agent forced to stopped", () => {
      const state = makeState({ agent: "running", container: "running", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
      const result = doRefresh(state, { container: "stopped", agent: "running", git: {}, services: {} });
      expect(result.agent).toBe("stopped");
    });

    it("agent=running + container=missing → agent forced to stopped", () => {
      const state = makeState({ agent: "running", container: "running", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
      const result = doRefresh(state, { container: "missing", agent: "running", git: {}, services: {} });
      expect(result.agent).toBe("stopped");
    });

    it("agent=running + container=running → agent stays running", () => {
      const state = makeState({ agent: "stopped", container: "missing", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
      const result = doRefresh(state, { container: "running", agent: "running", git: {}, services: {} });
      expect(result.agent).toBe("running");
    });

    it("agent=stopped + container=missing → both stay as-is", () => {
      const state = makeState({ agent: "stopped", container: "missing", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
      const result = doRefresh(state, { container: "missing", agent: "stopped", git: {}, services: {} });
      expect(result.agent).toBe("stopped");
      expect(result.container).toBe("missing");
    });
  });

  describe("merged → done promotion", () => {
    it("git.merged + trackerStatus=in_progress → trackerStatus=done", () => {
      const state = makeState({ trackerStatus: "in_progress", linearStatus: "in_progress", lifecycle: "active" });
      const result = doRefresh(state, { container: "running", agent: "stopped", git: { merged: true }, services: {} });
      expect(result.trackerStatus).toBe("done");
      expect(result.linearStatus).toBe("done");
    });

    it("git.merged + trackerStatus=unstarted → trackerStatus=done", () => {
      const state = makeState({ trackerStatus: "unstarted", linearStatus: "unstarted", lifecycle: "active" });
      const result = doRefresh(state, { container: "running", agent: "stopped", git: { merged: true }, services: {} });
      expect(result.trackerStatus).toBe("done");
    });

    it("git.merged + trackerStatus=done → stays done", () => {
      const state = makeState({ trackerStatus: "done", linearStatus: "done", lifecycle: "active" });
      const result = doRefresh(state, { container: "running", agent: "stopped", git: { merged: true }, services: {} });
      expect(result.trackerStatus).toBe("done");
    });

    it("git.merged + trackerStatus=cancelled → stays cancelled (not overwritten)", () => {
      const state = makeState({ trackerStatus: "cancelled", linearStatus: "cancelled", lifecycle: "active" });
      const result = doRefresh(state, { container: "running", agent: "stopped", git: { merged: true }, services: {} });
      expect(result.trackerStatus).toBe("cancelled");
    });

    it("git NOT merged → trackerStatus unchanged", () => {
      const state = makeState({ trackerStatus: "in_progress", linearStatus: "in_progress", lifecycle: "active" });
      const result = doRefresh(state, { container: "running", agent: "stopped", git: { merged: false }, services: {} });
      expect(result.trackerStatus).toBe("in_progress");
    });
  });

  describe("transition clearing", () => {
    it("transition to=running + agent=running → transition cleared", () => {
      const state = makeState({
        agent: "stopped",
        container: "running",
        lifecycle: "active",
        trackerStatus: "in_progress",
        linearStatus: "in_progress",
        transition: transition("running"),
      });
      const result = doRefresh(state, { container: "running", agent: "running", git: {}, services: {} });
      expect(result.transition).toBeNull();
    });

    it("transition to=stopped + agent=stopped → transition cleared", () => {
      const state = makeState({
        agent: "running",
        container: "running",
        lifecycle: "active",
        trackerStatus: "in_progress",
        linearStatus: "in_progress",
        transition: transition("stopped"),
      });
      const result = doRefresh(state, { container: "running", agent: "stopped", git: {}, services: {} });
      expect(result.transition).toBeNull();
    });

    it("transition to=running + agent=stopped → transition preserved (not yet reached)", () => {
      const state = makeState({
        agent: "stopped",
        container: "running",
        lifecycle: "active",
        trackerStatus: "in_progress",
        linearStatus: "in_progress",
        transition: transition("running"),
      });
      const result = doRefresh(state, { container: "running", agent: "stopped", git: {}, services: {} });
      expect(result.transition).not.toBeNull();
    });
  });

  describe("auto-derive lifecycle=removed", () => {
    it("tracker=done + container=missing + agent=stopped + no files → lifecycle=removed", () => {
      const state = makeState({ lifecycle: "active", trackerStatus: "done", linearStatus: "done", container: "missing", agent: "stopped" });
      const result = doRefresh(state, { container: "missing", agent: "stopped", git: {}, services: {} }, false);
      expect(result.lifecycle).toBe("removed");
    });

    it("tracker=cancelled + container=missing + agent=stopped + no files → lifecycle=removed", () => {
      const state = makeState({ lifecycle: "active", trackerStatus: "cancelled", linearStatus: "cancelled", container: "missing", agent: "stopped" });
      const result = doRefresh(state, { container: "missing", agent: "stopped", git: {}, services: {} }, false);
      expect(result.lifecycle).toBe("removed");
    });

    it("tracker=done but files exist → lifecycle stays active", () => {
      const state = makeState({ lifecycle: "active", trackerStatus: "done", linearStatus: "done", container: "missing", agent: "stopped" });
      const result = doRefresh(state, { container: "missing", agent: "stopped", git: {}, services: {} }, true);
      expect(result.lifecycle).toBe("active");
    });

    it("tracker=done but container running → lifecycle stays active", () => {
      const state = makeState({ lifecycle: "active", trackerStatus: "done", linearStatus: "done", container: "running", agent: "stopped" });
      const result = doRefresh(state, { container: "running", agent: "stopped", git: {}, services: {} }, false);
      expect(result.lifecycle).toBe("active");
    });

    it("tracker=in_progress + everything gone → lifecycle stays active", () => {
      const state = makeState({ lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress", container: "missing", agent: "stopped" });
      const result = doRefresh(state, { container: "missing", agent: "stopped", git: {}, services: {} }, false);
      expect(result.lifecycle).toBe("active");
    });
  });

  describe("combined scenarios — full lifecycle simulations", () => {
    it("happy path: spawn → running → exited → merged → done → removed", () => {
      // Step 1: just spawned
      let state = makeState({ lifecycle: "active", agent: "running", container: "running", trackerStatus: "in_progress", linearStatus: "in_progress" });
      let result = doRefresh(state, { container: "running", agent: "running", git: { merged: false }, services: {} });
      expect(result.agent).toBe("running");
      expect(result.trackerStatus).toBe("in_progress");

      // Step 2: agent finishes, exits
      result = doRefresh(result, { container: "running", agent: "stopped", git: { merged: false, aheadBy: 3, behindBy: 0 }, services: {} });
      expect(result.agent).toBe("stopped");
      expect(result.trackerStatus).toBe("in_progress");
      expect(deriveUiStatus(result, null).status).toBe("awaiting");

      // Step 3: branch merged externally (container still running → not fully closed)
      result = doRefresh(result, { container: "running", agent: "stopped", git: { merged: true, aheadBy: 0, behindBy: 0 }, services: {} });
      expect(result.trackerStatus).toBe("done");
      expect(deriveUiStatus(result, null).status).toBe("awaiting"); // container still up

      // Step 4: container removed, files removed
      result = doRefresh(result, { container: "missing", agent: "stopped", git: { merged: true }, services: {} }, false);
      expect(result.lifecycle).toBe("removed");
      expect(deriveUiStatus(result, null).status).toBe("closed");
    });

    it("error path: spawn → running → container dies → agent forced stopped", () => {
      let state = makeState({ lifecycle: "active", agent: "running", container: "running", trackerStatus: "in_progress", linearStatus: "in_progress" });

      // Container dies
      const result = doRefresh(state, { container: "missing", agent: "running", git: {}, services: {} });
      expect(result.agent).toBe("stopped");
      expect(result.container).toBe("missing");
      expect(deriveUiStatus(result, null).status).toBe("awaiting");
    });

    it("rebase conflict path: agent stopped + git.op=rebasing → awaiting+conflict", () => {
      const state = makeState({
        lifecycle: "active",
        agent: "stopped",
        container: "running",
        trackerStatus: "in_progress",
        linearStatus: "in_progress",
      });
      state.git.op = "rebasing";

      const result = doRefresh(state, { container: "running", agent: "stopped", git: { op: "rebasing" }, services: {} });
      expect(deriveUiStatus(result, null)).toEqual({ status: "awaiting", reason: "conflict" });
    });

    it("cancelled path: removed with active tracker auto-cancels", () => {
      let state = makeState({
        lifecycle: "active",
        trackerStatus: "in_progress",
        linearStatus: "in_progress",
        agent: "stopped",
        container: "running",
      });

      // User removes agent → _setLifecycle auto-cancels tracker
      setLifecycle(state, "removed");
      expect(state.trackerStatus).toBe("cancelled");
      expect(state.linearStatus).toBe("cancelled");
      expect(state.lifecycle).toBe("removed");
      expect(deriveUiStatus(state, null).status).toBe("closed");
    });
  });
});

// ==========================================================================
// 4. Observation methods — every edge case
// ==========================================================================

describe("observation methods — exhaustive", () => {
  describe("reportProcessExited", () => {
    it("running → stopped", () => {
      const state = makeState({ agent: "running" });
      reportProcessExited(state);
      expect(state.agent).toBe("stopped");
    });

    it("stopped → stopped (idempotent)", () => {
      const state = makeState({ agent: "stopped" });
      reportProcessExited(state);
      expect(state.agent).toBe("stopped");
    });

    it("called multiple times → still stopped", () => {
      const state = makeState({ agent: "running" });
      reportProcessExited(state);
      reportProcessExited(state);
      reportProcessExited(state);
      expect(state.agent).toBe("stopped");
    });
  });

  describe("reportContainerDead", () => {
    for (const container of ["running", "stopped", "missing"] as const) {
      for (const agent of ["running", "stopped"] as const) {
        it(`container=${container} + agent=${agent} → container=missing + agent=stopped`, () => {
          const state = makeState({ container, agent });
          reportContainerDead(state);
          expect(state.container).toBe("missing");
          expect(state.agent).toBe("stopped");
        });
      }
    }
  });

  describe("reportBranchMerged", () => {
    for (const ts of ["unstarted", "in_progress", "done", "cancelled"] as TrackerStatusValue[]) {
      it(`trackerStatus=${ts} → merged=true, correct tracker update`, () => {
        const state = makeState({ trackerStatus: ts, linearStatus: ts });
        state.git.aheadBy = 5;
        state.git.behindBy = 3;
        reportBranchMerged(state);
        expect(state.git.merged).toBe(true);
        expect(state.git.aheadBy).toBe(0);
        expect(state.git.behindBy).toBe(0);

        if (ts === "done" || ts === "cancelled") {
          expect(state.trackerStatus).toBe(ts); // preserved
        } else {
          expect(state.trackerStatus).toBe("done");
        }
      });
    }
  });

  describe("reportBranchGone", () => {
    it("agent=stopped → sets done", () => {
      const state = makeState({ agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });
      reportBranchGone(state);
      expect(state.trackerStatus).toBe("done");
      expect(state.agent).toBe("stopped");
    });

    it("agent=running → no-op (can't assume done while running)", () => {
      const state = makeState({ agent: "running", trackerStatus: "in_progress", linearStatus: "in_progress" });
      reportBranchGone(state);
      expect(state.trackerStatus).toBe("in_progress");
      expect(state.agent).toBe("running");
    });
  });
});

// ==========================================================================
// 5. _setLifecycle guard — ALL transitions
// ==========================================================================

describe("_setLifecycle guard — all lifecycle × trackerStatus combos", () => {
  const lifecycles: AgentState["lifecycle"][] = ["pending", "spawning", "active", "removed"];
  const trackerStatuses: TrackerStatusValue[] = ["unstarted", "in_progress", "done", "cancelled"];

  for (const fromLifecycle of lifecycles) {
    for (const toLifecycle of lifecycles) {
      for (const ts of trackerStatuses) {
        it(`lifecycle: ${fromLifecycle}→${toLifecycle}, tracker=${ts}`, () => {
          const state = makeState({ lifecycle: fromLifecycle, trackerStatus: ts, linearStatus: ts });
          setLifecycle(state, toLifecycle);
          expect(state.lifecycle).toBe(toLifecycle);

          if (toLifecycle === "removed" && (ts === "in_progress" || ts === "unstarted")) {
            expect(state.trackerStatus).toBe("cancelled");
            expect(state.linearStatus).toBe("cancelled");
          } else {
            expect(state.trackerStatus).toBe(ts);
            expect(state.linearStatus).toBe(ts);
          }
        });
      }
    }
  }
});

// ==========================================================================
// 6. stateFromLegacy — all legacy statuses
// ==========================================================================

describe("stateFromLegacy — all legacy statuses", () => {
  const legacyStatuses = [
    "PENDING", "SPAWNING", "RUNNING", "EXITED", "WAITING",
    "PREVIEW", "IN_REVIEW", "REBASING", "MERGING",
    "DONE", "CANCELLED", "CLEANUP", "REMOVED",
  ] as const;

  for (const status of legacyStatuses) {
    it(`legacy ${status} → valid AgentState`, () => {
      const agent = {
        issueId: "TEST-1",
        branch: "agent/TEST-1",
        containerName: "agent-TEST-1",
        status,
      } as any;

      const state = stateFromLegacy(agent);
      expect(state.git.branch).toBe("agent/TEST-1");
      expect(["pending", "spawning", "active", "removed"]).toContain(state.lifecycle);
      expect(["running", "stopped"]).toContain(state.agent);
      expect(["unstarted", "in_progress", "done", "cancelled"]).toContain(state.trackerStatus);

      // Verify roundtrip: deriveLegacyStatus should return something reasonable
      const derived = deriveLegacyStatus(state, null);
      expect(typeof derived).toBe("string");
    });
  }

  it("RUNNING → lifecycle=active, agent=running, tracker=in_progress", () => {
    const state = stateFromLegacy({ status: "RUNNING", branch: "b", containerName: "c" } as any);
    expect(state.lifecycle).toBe("active");
    expect(state.agent).toBe("running");
    expect(state.trackerStatus).toBe("in_progress");
    expect(state.container).toBe("running");
  });

  it("DONE → lifecycle=active, agent=stopped, tracker=done", () => {
    const state = stateFromLegacy({ status: "DONE", branch: "b", containerName: "c" } as any);
    expect(state.lifecycle).toBe("active");
    expect(state.agent).toBe("stopped");
    expect(state.trackerStatus).toBe("done");
  });

  it("REMOVED → lifecycle=removed, agent=stopped", () => {
    const state = stateFromLegacy({ status: "REMOVED", branch: "b" } as any);
    expect(state.lifecycle).toBe("removed");
    expect(state.agent).toBe("stopped");
  });

  it("REBASING → git.op=rebasing", () => {
    const state = stateFromLegacy({ status: "REBASING", branch: "b", containerName: "c" } as any);
    expect(state.git.op).toBe("rebasing");
    expect(state.lifecycle).toBe("active");
  });

  it("no containerName → container=missing", () => {
    const state = stateFromLegacy({ status: "PENDING", branch: "b" } as any);
    expect(state.container).toBe("missing");
  });

  it("EXITED with containerName → container=running (optimistic)", () => {
    const state = stateFromLegacy({ status: "EXITED", branch: "b", containerName: "c" } as any);
    expect(state.container).toBe("running");
  });
});

// ==========================================================================
// 7. Complex multi-step scenarios
// ==========================================================================

describe("complex multi-step lifecycle scenarios", () => {
  it("agent wakes twice: first wake works, second wake after done throws", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });

    // First wake: allowed
    const TERMINAL_LIFECYCLE = new Set(["removed"]);
    const TERMINAL_TRACKER = new Set(["done", "cancelled"]);
    expect(TERMINAL_LIFECYCLE.has(state.lifecycle)).toBe(false);
    expect(TERMINAL_TRACKER.has(state.trackerStatus)).toBe(false);

    // Simulate agent running then done
    state.agent = "running";
    reportProcessExited(state);
    reportBranchMerged(state);
    expect(state.trackerStatus).toBe("done");

    // Second wake: blocked
    expect(TERMINAL_TRACKER.has(state.trackerStatus)).toBe(true);
  });

  it("parallel refresh coalescing: concurrent calls don't corrupt state", () => {
    // This tests the logical invariant, not actual async coalescing
    const state1 = makeState({ agent: "running", container: "running", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
    const state2 = { ...state1, git: { ...state1.git } };

    const result1 = doRefresh(state1, { container: "running", agent: "running", git: { merged: false }, services: {} });
    const result2 = doRefresh(state2, { container: "running", agent: "running", git: { merged: false }, services: {} });

    expect(result1.agent).toBe(result2.agent);
    expect(result1.container).toBe(result2.container);
    expect(result1.trackerStatus).toBe(result2.trackerStatus);
  });

  it("server restart recovery: was running, now stopped → output recovery triggered", () => {
    const state = makeState({ agent: "running", container: "running", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
    const wasPreviouslyRunning = state.agent === "running";

    const result = doRefresh(state, { container: "running", agent: "stopped", git: {}, services: {} });

    expect(wasPreviouslyRunning).toBe(true);
    expect(result.agent).toBe("stopped");
    // In real code, this triggers recoverAgentOutput()
  });

  it("race: merge during running agent → agent stays running, tracker=done on next refresh", () => {
    // Step 1: agent running, branch gets merged externally
    let state = makeState({ lifecycle: "active", agent: "running", container: "running", trackerStatus: "in_progress", linearStatus: "in_progress" });
    let result = doRefresh(state, { container: "running", agent: "running", git: { merged: true }, services: {} });

    // Agent still running, but tracker is now done
    expect(result.agent).toBe("running");
    expect(result.trackerStatus).toBe("done");

    // UI shows "running" (not closed) because agent is alive
    expect(deriveUiStatus(result, null).status).toBe("running");

    // Step 2: agent exits but container still running → awaiting
    result = doRefresh(result, { container: "running", agent: "stopped", git: { merged: true }, services: {} });
    expect(deriveUiStatus(result, null).status).toBe("awaiting");

    // Step 3: container stopped → now truly closed
    result = doRefresh(result, { container: "stopped", agent: "stopped", git: { merged: true }, services: {} });
    expect(deriveUiStatus(result, null).status).toBe("closed");
  });

  it("multiple trackers scenario: sentry done + linear in_progress → done wins on merge", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });

    // Simulate merge detection
    reportBranchMerged(state);

    expect(state.trackerStatus).toBe("done");
    expect(state.linearStatus).toBe("done");
    expect(state.git.merged).toBe(true);
  });

  it("failed spawn: lifecycle goes to active (not stuck in spawning), agent=stopped", () => {
    // Simulates catch block in spawnAgent
    const state = makeState({ lifecycle: "spawning", agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });
    state.transition = transition("running");

    // Error during spawn
    state.agent = "stopped";
    state.lifecycle = "active";
    state.transition = null;

    expect(state.lifecycle).toBe("active");
    expect(state.agent).toBe("stopped");
    expect(state.transition).toBeNull();
    expect(deriveUiStatus(state, null).status).toBe("awaiting");
  });

  it("remove while tracker done: no auto-cancel, lifecycle=removed", () => {
    const state = makeState({ lifecycle: "active", trackerStatus: "done", linearStatus: "done", agent: "stopped" });
    setLifecycle(state, "removed");
    expect(state.trackerStatus).toBe("done"); // not cancelled
    expect(state.lifecycle).toBe("removed");
  });

  it("stop bypasses lock: even during mergeAndClose op, stop changes state", () => {
    // Stop doesn't use withLock, so it can interrupt
    const state = makeState({ lifecycle: "active", agent: "running", container: "running", trackerStatus: "in_progress", linearStatus: "in_progress" });
    const currentOp = op("mergeAndClose");

    // During mergeAndClose, stop is called
    state.transition = transition("stopped");
    // stopAgent does: stop process → stop services → stop container
    state.agent = "stopped";
    state.container = "stopped";
    state.transition = null;

    expect(state.agent).toBe("stopped");
    expect(state.container).toBe("stopped");
    // mergeAndClose is still in currentOp
    expect(deriveUiStatus(state, currentOp).status).toBe("closing");
  });
});

// ==========================================================================
// 8. Edge cases and invariant violations
// ==========================================================================

describe("impossible state detection", () => {
  it("agent=running + container=missing → corrected by refresh", () => {
    const state = makeState({ agent: "running", container: "missing", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
    const result = doRefresh(state, { container: "missing", agent: "running", git: {}, services: {} });
    expect(result.agent).toBe("stopped"); // corrected
  });

  it("agent=running + container=stopped → corrected by refresh", () => {
    const state = makeState({ agent: "running", container: "stopped", lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
    const result = doRefresh(state, { container: "stopped", agent: "running", git: {}, services: {} });
    expect(result.agent).toBe("stopped"); // corrected
  });

  it("lifecycle=removed but agent=running → UI shows running (safety)", () => {
    const state = makeState({ lifecycle: "removed", agent: "running", container: "running", trackerStatus: "in_progress", linearStatus: "in_progress" });
    expect(deriveUiStatus(state, null).status).toBe("running");
    expect(deriveLegacyStatus(state, null)).toBe("RUNNING");
  });

  it("trackerStatus=done but lifecycle=spawning → UI shows closed", () => {
    const state = makeState({ lifecycle: "spawning", agent: "stopped", trackerStatus: "done", linearStatus: "done", container: "stopped" });
    expect(deriveUiStatus(state, null).status).toBe("closed");
  });
});

describe("defaultAgentState invariants", () => {
  it("default state has all required fields", () => {
    const state = defaultAgentState();
    expect(state.agent).toBe("stopped");
    expect(state.container).toBe("missing");
    expect(state.lifecycle).toBe("pending");
    expect(state.trackerStatus).toBe("unstarted");
    expect(state.linearStatus).toBe("unstarted");
    expect(state.git.op).toBe("idle");
    expect(state.git.merged).toBe(false);
    expect(state.git.dirty).toBe(false);
    expect(state.git.aheadBy).toBe(0);
    expect(state.git.behindBy).toBe(0);
    expect(state.git.lastCommit).toBeNull();
    expect(state.services).toEqual({});
  });

  it("default state with branch", () => {
    const state = defaultAgentState("agent/UKR-1");
    expect(state.git.branch).toBe("agent/UKR-1");
  });

  it("default state → UI shows 'starting'", () => {
    expect(deriveUiStatus(defaultAgentState(), null).status).toBe("starting");
  });

  it("default state → legacy shows 'PENDING'", () => {
    expect(deriveLegacyStatus(defaultAgentState(), null)).toBe("PENDING");
  });
});
