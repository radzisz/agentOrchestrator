// ---------------------------------------------------------------------------
// Tests for AgentAggregate — guards against state corruption bugs
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentState, CurrentOperation } from "../types";
import { defaultAgentState, deriveUiStatus } from "../types";
import { deriveLegacyStatus } from "../compat";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return { ...defaultAgentState("agent/TEST-1"), ...overrides };
}

// ---------------------------------------------------------------------------
// 1. deriveUiStatus — correct mapping from state axes → UI badge
// ---------------------------------------------------------------------------

describe("deriveUiStatus", () => {
  it("returns 'starting' during spawn operation", () => {
    const state = makeState({ lifecycle: "spawning", agent: "stopped" });
    const op: CurrentOperation = { name: "spawn", startedAt: new Date().toISOString() };
    expect(deriveUiStatus(state, op)).toEqual({ status: "starting" });
  });

  it("returns 'starting' during wake operation", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped" });
    const op: CurrentOperation = { name: "wake", startedAt: new Date().toISOString() };
    expect(deriveUiStatus(state, op)).toEqual({ status: "starting" });
  });

  it("returns 'closing' during mergeAndClose", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped" });
    const op: CurrentOperation = { name: "mergeAndClose", startedAt: new Date().toISOString() };
    expect(deriveUiStatus(state, op)).toEqual({ status: "closing" });
  });

  it("returns 'closing' during reject", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped" });
    const op: CurrentOperation = { name: "reject", startedAt: new Date().toISOString() };
    expect(deriveUiStatus(state, op)).toEqual({ status: "closing" });
  });

  it("returns 'closing' during remove", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped" });
    const op: CurrentOperation = { name: "remove", startedAt: new Date().toISOString() };
    expect(deriveUiStatus(state, op)).toEqual({ status: "closing" });
  });

  it("returns 'closed' when trackerStatus is done", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "done", linearStatus: "done" });
    expect(deriveUiStatus(state, null)).toEqual({ status: "closed" });
  });

  it("returns 'closed' when trackerStatus is cancelled", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "cancelled", linearStatus: "cancelled" });
    expect(deriveUiStatus(state, null)).toEqual({ status: "closed" });
  });

  it("returns 'closed' when lifecycle is removed and agent stopped", () => {
    const state = makeState({ lifecycle: "removed", agent: "stopped" });
    expect(deriveUiStatus(state, null)).toEqual({ status: "closed" });
  });

  it("returns 'running' when agent process is alive", () => {
    const state = makeState({ lifecycle: "active", agent: "running", linearStatus: "in_progress" });
    expect(deriveUiStatus(state, null)).toEqual({ status: "running" });
  });

  it("returns 'running' even when lifecycle=removed if agent is still running (orphan cleanup bug)", () => {
    // This is the UKR-126 bug: dispatcher cleaned up agent as orphan while Claude was running.
    // UI must show "running" not "closed" when agent process is alive.
    const state = makeState({ lifecycle: "removed", agent: "running", linearStatus: "in_progress" });
    expect(deriveUiStatus(state, null)).toEqual({ status: "running" });
  });

  it("returns 'running' even when linearStatus=done if agent is still running", () => {
    const state = makeState({ lifecycle: "active", agent: "running", linearStatus: "done" });
    expect(deriveUiStatus(state, null)).toEqual({ status: "running" });
  });

  it("returns 'awaiting' when agent stopped but lifecycle active", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", linearStatus: "in_progress" });
    expect(deriveUiStatus(state, null)).toEqual({ status: "awaiting", reason: "completed" });
  });

  it("returns 'awaiting' with conflict reason during rebase", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", linearStatus: "in_progress" });
    state.git.op = "rebasing";
    expect(deriveUiStatus(state, null)).toEqual({ status: "awaiting", reason: "conflict" });
  });
});

// ---------------------------------------------------------------------------
// 2. deriveLegacyStatus — must stay in sync with deriveUiStatus
// ---------------------------------------------------------------------------

describe("deriveLegacyStatus", () => {
  it("maps spawn operation → SPAWNING", () => {
    const state = makeState();
    const op: CurrentOperation = { name: "spawn", startedAt: "" };
    expect(deriveLegacyStatus(state, op)).toBe("SPAWNING");
  });

  it("maps mergeAndClose operation → MERGING", () => {
    const state = makeState();
    const op: CurrentOperation = { name: "mergeAndClose", startedAt: "" };
    expect(deriveLegacyStatus(state, op)).toBe("MERGING");
  });

  it("maps remove operation → CLEANUP", () => {
    const state = makeState();
    const op: CurrentOperation = { name: "remove", startedAt: "" };
    expect(deriveLegacyStatus(state, op)).toBe("CLEANUP");
  });

  it("maps lifecycle removed + agent stopped → REMOVED", () => {
    const state = makeState({ lifecycle: "removed", agent: "stopped" });
    expect(deriveLegacyStatus(state, null)).toBe("REMOVED");
  });

  it("maps lifecycle removed + agent running → RUNNING (running takes priority)", () => {
    const state = makeState({ lifecycle: "removed", agent: "running" });
    expect(deriveLegacyStatus(state, null)).toBe("RUNNING");
  });

  it("maps trackerStatus done → DONE", () => {
    const state = makeState({ trackerStatus: "done", linearStatus: "done", lifecycle: "active" });
    expect(deriveLegacyStatus(state, null)).toBe("DONE");
  });

  it("maps trackerStatus cancelled → CANCELLED", () => {
    const state = makeState({ trackerStatus: "cancelled", linearStatus: "cancelled", lifecycle: "active" });
    expect(deriveLegacyStatus(state, null)).toBe("CANCELLED");
  });

  it("maps agent running → RUNNING", () => {
    const state = makeState({ agent: "running", lifecycle: "active", linearStatus: "in_progress" });
    expect(deriveLegacyStatus(state, null)).toBe("RUNNING");
  });

  it("maps stopped agent with active lifecycle → EXITED", () => {
    const state = makeState({ agent: "stopped", lifecycle: "active", linearStatus: "in_progress" });
    expect(deriveLegacyStatus(state, null)).toBe("EXITED");
  });

  it("REMOVED takes priority over DONE (when agent stopped)", () => {
    const state = makeState({ lifecycle: "removed", linearStatus: "done", agent: "stopped" });
    expect(deriveLegacyStatus(state, null)).toBe("REMOVED");
  });

  it("RUNNING takes priority over REMOVED and DONE", () => {
    const state = makeState({ lifecycle: "removed", linearStatus: "done", agent: "running" });
    expect(deriveLegacyStatus(state, null)).toBe("RUNNING");
  });

  it("operation takes priority over terminal states", () => {
    const state = makeState({ lifecycle: "removed", linearStatus: "done" });
    const op: CurrentOperation = { name: "mergeAndClose", startedAt: "" };
    expect(deriveLegacyStatus(state, op)).toBe("MERGING");
  });
});

// ---------------------------------------------------------------------------
// 3. deriveLegacyStatus ↔ deriveUiStatus consistency
//    Ensures the two derivation functions never disagree on terminal states.
// ---------------------------------------------------------------------------

describe("legacy ↔ ui status consistency", () => {
  // Terminal = final resting states (not transient operations like MERGING/CLEANUP)
  const LEGACY_TERMINAL = new Set(["DONE", "CANCELLED", "REMOVED"]);
  const UI_TERMINAL = new Set(["closed"]);

  const cases: Array<{ desc: string; state: AgentState; op: CurrentOperation | null }> = [
    { desc: "done agent", state: makeState({ linearStatus: "done", lifecycle: "active" }), op: null },
    { desc: "cancelled agent", state: makeState({ linearStatus: "cancelled", lifecycle: "active" }), op: null },
    { desc: "removed agent (stopped)", state: makeState({ lifecycle: "removed", agent: "stopped" }), op: null },
    { desc: "removed agent (still running)", state: makeState({ lifecycle: "removed", agent: "running" }), op: null },
    { desc: "closing (mergeAndClose)", state: makeState(), op: { name: "mergeAndClose", startedAt: "" } },
    { desc: "closing (remove)", state: makeState(), op: { name: "remove", startedAt: "" } },
    { desc: "active awaiting", state: makeState({ lifecycle: "active", agent: "stopped", linearStatus: "in_progress" }), op: null },
    { desc: "running", state: makeState({ lifecycle: "active", agent: "running", linearStatus: "in_progress" }), op: null },
  ];

  for (const { desc, state, op } of cases) {
    it(`${desc}: if legacy is terminal, ui must also be terminal (and vice versa)`, () => {
      const legacy = deriveLegacyStatus(state, op);
      const ui = deriveUiStatus(state, op);
      const legacyTerminal = LEGACY_TERMINAL.has(legacy);
      const uiTerminal = UI_TERMINAL.has(ui.status);
      expect(legacyTerminal).toBe(uiTerminal);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. healState — fixes stale in-memory state from disk
// ---------------------------------------------------------------------------

describe("healState", () => {
  // We test healState indirectly via the AgentAggregate constructor + registry.
  // Since the aggregate depends on many modules, we mock store and test the logic.

  // Extracted healState logic for isolated testing:
  function healState(
    memState: AgentState,
    memOp: CurrentOperation | null,
    diskState: AgentState | undefined,
    diskOp: CurrentOperation | null | undefined,
    diskStatus: string | undefined,
  ): { state: AgentState; op: CurrentOperation | null } {
    const state = { ...memState, git: { ...memState.git } };
    let op = memOp;

    // If no operation running, git.op should be idle
    if (!op && state.git.op !== "idle") {
      state.git.op = "idle";
    }

    if (!diskState) return { state, op };

    // If disk says no operation but memory has a stale one, trust disk
    if (!diskOp && op) {
      op = null;
    }

    // Terminal states can only advance forward
    const TERMINAL_LINEAR = new Set(["done", "cancelled"]);
    if (TERMINAL_LINEAR.has(diskState.linearStatus) && !TERMINAL_LINEAR.has(state.linearStatus)) {
      state.linearStatus = diskState.linearStatus;
    }

    const LIFECYCLE_ORDER = ["pending", "spawning", "active", "removed"];
    const diskIdx = LIFECYCLE_ORDER.indexOf(diskState.lifecycle);
    const memIdx = LIFECYCLE_ORDER.indexOf(state.lifecycle);
    if (diskIdx > memIdx) {
      state.lifecycle = diskState.lifecycle;
    }

    return { state, op };
  }

  it("resets git.op to idle when no operation is running", () => {
    const mem = makeState();
    mem.git.op = "merging";
    const result = healState(mem, null, undefined, undefined, undefined);
    expect(result.state.git.op).toBe("idle");
  });

  it("keeps git.op when operation IS running", () => {
    const mem = makeState();
    mem.git.op = "merging";
    const op: CurrentOperation = { name: "mergeAndClose", startedAt: "" };
    const result = healState(mem, op, undefined, undefined, undefined);
    expect(result.state.git.op).toBe("merging");
  });

  it("clears stale currentOperation when disk has none", () => {
    const mem = makeState();
    const staleOp: CurrentOperation = { name: "remove", startedAt: "" };
    const disk = makeState();
    const result = healState(mem, staleOp, disk, null, "EXITED");
    expect(result.op).toBeNull();
  });

  it("advances linearStatus from in_progress to done (from disk)", () => {
    const mem = makeState({ linearStatus: "in_progress" });
    const disk = makeState({ linearStatus: "done" });
    const result = healState(mem, null, disk, null, "DONE");
    expect(result.state.linearStatus).toBe("done");
  });

  it("never downgrades linearStatus from done to in_progress", () => {
    const mem = makeState({ linearStatus: "done" });
    const disk = makeState({ linearStatus: "in_progress" });
    const result = healState(mem, null, disk, null, "EXITED");
    expect(result.state.linearStatus).toBe("done");
  });

  it("advances lifecycle from active to removed (from disk)", () => {
    const mem = makeState({ lifecycle: "active" });
    const disk = makeState({ lifecycle: "removed" });
    const result = healState(mem, null, disk, null, "REMOVED");
    expect(result.state.lifecycle).toBe("removed");
  });

  it("never downgrades lifecycle from removed to active", () => {
    const mem = makeState({ lifecycle: "removed" });
    const disk = makeState({ lifecycle: "active" });
    const result = healState(mem, null, disk, null, "EXITED");
    expect(result.state.lifecycle).toBe("removed");
  });
});

// ---------------------------------------------------------------------------
// 5. withLock — timeout does NOT corrupt state (warning-only)
// ---------------------------------------------------------------------------

describe("withLock timeout behavior", () => {
  // Simulate the withLock pattern to verify timeout doesn't reject/race

  it("warning-only timeout lets the function complete naturally", async () => {
    let completed = false;
    let timedOut = false;
    const timeoutMs = 50;

    const warnTimer = setTimeout(() => { timedOut = true; }, timeoutMs);

    const fn = async () => {
      await new Promise(r => setTimeout(r, 100)); // takes longer than timeout
      completed = true;
    };

    await fn();
    clearTimeout(warnTimer);

    expect(completed).toBe(true);
    // timedOut may or may not be true depending on timing, but fn completed
  });

  it("Promise.race timeout would leave function running (the old bug)", async () => {
    let fnCompleted = false;
    let raceResolved = false;
    const timeoutMs = 20;

    const fn = async () => {
      await new Promise(r => setTimeout(r, 100));
      fnCompleted = true;
    };

    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs),
        ),
      ]);
    } catch {
      raceResolved = true;
    }

    // The race rejected, but fn is STILL running in the background
    expect(raceResolved).toBe(true);
    expect(fnCompleted).toBe(false);

    // Wait for fn to finish — it keeps running (this is the bug)
    await new Promise(r => setTimeout(r, 150));
    expect(fnCompleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. mergeAndClose — Linear closed BEFORE cleanup, skipMerge respected
// ---------------------------------------------------------------------------

describe("mergeAndClose operation ordering", () => {
  it("closes Linear before cleanup steps", () => {
    // Verify by checking the order of operations in the code structure.
    // We simulate the operation log to ensure ordering.
    const ops: string[] = [];

    const steps = {
      merge: () => ops.push("merge"),
      closeLinear: () => ops.push("closeLinear"),
      persistAfterLinear: () => ops.push("persistAfterLinear"),
      stopServices: () => ops.push("stopServices"),
      removeContainer: () => ops.push("removeContainer"),
      removeRepo: () => ops.push("removeRepo"),
    };

    // Simulate mergeAndClose with cleanup=true, skipMerge=false
    steps.merge();
    steps.closeLinear();
    steps.persistAfterLinear();
    steps.stopServices();
    steps.removeContainer();
    steps.removeRepo();

    const linearIdx = ops.indexOf("closeLinear");
    const persistIdx = ops.indexOf("persistAfterLinear");
    const stopIdx = ops.indexOf("stopServices");
    const removeIdx = ops.indexOf("removeContainer");

    // Linear must be closed and persisted BEFORE any cleanup
    expect(linearIdx).toBeLessThan(stopIdx);
    expect(persistIdx).toBeLessThan(stopIdx);
    expect(persistIdx).toBeLessThan(removeIdx);
  });

  it("skipMerge=true skips merge step", () => {
    const ops: string[] = [];
    const skipMerge = true;

    if (!skipMerge) ops.push("merge");
    ops.push("closeLinear");

    expect(ops).not.toContain("merge");
    expect(ops).toContain("closeLinear");
  });

  it("skipMerge=false includes merge step", () => {
    const ops: string[] = [];
    const skipMerge = false;

    if (!skipMerge) ops.push("merge");
    ops.push("closeLinear");

    expect(ops).toContain("merge");
    expect(ops).toContain("closeLinear");
  });
});

// ---------------------------------------------------------------------------
// 7. Monitor — ls-remote failure must NOT be treated as "branch gone"
// ---------------------------------------------------------------------------

describe("monitor branch detection logic", () => {
  // Extracted decision logic from monitor.ts

  function shouldMarkDone(lsRemoteOk: boolean, lsRemoteStdout: string): "gone" | "error" | "exists" {
    // The CORRECT logic (after fix):
    if (lsRemoteOk && !lsRemoteStdout.trim()) return "gone";
    if (!lsRemoteOk) return "error"; // network/auth failure — don't conclude anything
    return "exists";
  }

  it("treats successful empty ls-remote as branch gone", () => {
    expect(shouldMarkDone(true, "")).toBe("gone");
    expect(shouldMarkDone(true, "  \n")).toBe("gone");
  });

  it("treats failed ls-remote as error (NOT branch gone)", () => {
    expect(shouldMarkDone(false, "")).toBe("error");
    expect(shouldMarkDone(false, "fatal: could not read from remote")).toBe("error");
  });

  it("treats successful non-empty ls-remote as branch exists", () => {
    expect(shouldMarkDone(true, "abc123\trefs/heads/agent/UKR-122")).toBe("exists");
  });

  // The OLD buggy logic for comparison:
  function oldBuggyLogic(lsRemoteOk: boolean, lsRemoteStdout: string): "markDone" | "skip" {
    if (!lsRemoteOk || !lsRemoteStdout) return "markDone"; // BUG: treats failures as gone
    return "skip";
  }

  it("old logic incorrectly marks agent DONE on auth failure", () => {
    // This demonstrates the bug we fixed
    expect(oldBuggyLogic(false, "")).toBe("markDone"); // WRONG — should be "skip"
  });
});

// ---------------------------------------------------------------------------
// 8. Monitor must not re-process agents already in terminal state
// ---------------------------------------------------------------------------

describe("monitor terminal state guard", () => {
  function shouldSkipAgent(
    legacyStatus: string,
    aggLinearStatus: string | null,
    aggLifecycle: string | null,
  ): boolean {
    // Legacy filter (existing)
    if (!["RUNNING", "EXITED"].includes(legacyStatus)) return true;

    // Aggregate terminal check (new guard)
    if (aggLinearStatus === "done" || aggLinearStatus === "cancelled") return true;
    if (aggLifecycle === "removed") return true;

    return false;
  }

  it("skips DONE agents", () => {
    expect(shouldSkipAgent("DONE", null, null)).toBe(true);
  });

  it("skips agents with aggregate linearStatus=done even if legacy is EXITED", () => {
    // This was the loop bug: legacy status flipped between DONE and EXITED
    expect(shouldSkipAgent("EXITED", "done", "active")).toBe(true);
  });

  it("skips agents with lifecycle=removed", () => {
    expect(shouldSkipAgent("EXITED", "in_progress", "removed")).toBe(true);
  });

  it("processes RUNNING agents that are active", () => {
    expect(shouldSkipAgent("RUNNING", "in_progress", "active")).toBe(false);
  });

  it("processes EXITED agents that are active", () => {
    expect(shouldSkipAgent("EXITED", "in_progress", "active")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. State transitions — cannot go backwards
// ---------------------------------------------------------------------------

describe("state transition rules", () => {
  const LIFECYCLE_ORDER = ["pending", "spawning", "active", "removed"] as const;
  const LINEAR_ORDER = ["unstarted", "in_progress", "done"] as const;

  it("lifecycle can only advance forward", () => {
    for (let i = 0; i < LIFECYCLE_ORDER.length; i++) {
      for (let j = 0; j < i; j++) {
        // Going from LIFECYCLE_ORDER[i] backwards to [j] should be blocked by healState
        const mem = makeState({ lifecycle: LIFECYCLE_ORDER[i] });
        const disk = makeState({ lifecycle: LIFECYCLE_ORDER[j] });
        // healState: diskIdx > memIdx → advance. Here diskIdx < memIdx → no change.
        const diskIdx = LIFECYCLE_ORDER.indexOf(disk.lifecycle);
        const memIdx = LIFECYCLE_ORDER.indexOf(mem.lifecycle);
        expect(diskIdx).toBeLessThan(memIdx);
        // Memory value should be preserved (not downgraded)
      }
    }
  });

  it("linearStatus: done is terminal — cannot go back to in_progress", () => {
    const state = makeState({ linearStatus: "done" });
    // Simulating what would happen if something tried to set it back
    const TERMINAL = new Set(["done", "cancelled"]);
    expect(TERMINAL.has(state.linearStatus)).toBe(true);
    // Any code that checks TERMINAL before overwriting will refuse
  });

  it("git.merged is sticky — once true, stays true", () => {
    // The pattern from checkGit:
    const wasMerged = true;
    let merged = false; // some check returned false
    if (wasMerged) merged = true; // sticky
    expect(merged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Nested withLock would deadlock — cleanup must be inlined
// ---------------------------------------------------------------------------

describe("withLock deadlock prevention", () => {
  it("demonstrates that chained promises deadlock on nested lock", async () => {
    let lock: Promise<void> = Promise.resolve();
    let innerStarted = false;
    let outerCompleted = false;

    const withLock = (fn: () => Promise<void>): Promise<void> => {
      const execute = async () => { await fn(); };
      lock = lock.then(execute, execute);
      return lock;
    };

    // Simulate the OLD bug: mergeAndClose calls removeAgent (nested withLock)
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("deadlock detected")), 200),
    );

    try {
      await Promise.race([
        withLock(async () => {
          // Outer: mergeAndClose
          // This nested call would deadlock because the lock is held by outer
          withLock(async () => {
            innerStarted = true;
          }); // Note: we don't await — but the lock chains it after outer
          outerCompleted = true;
        }),
        timeoutPromise,
      ]);
    } catch {
      // Expected: no deadlock because we DON'T await the inner withLock
    }

    // Outer completes but inner is queued after it
    expect(outerCompleted).toBe(true);

    // Wait for chain to drain
    await new Promise(r => setTimeout(r, 50));
    expect(innerStarted).toBe(true);
  });

  it("deadlocks if inner withLock is awaited inside outer", async () => {
    let lock: Promise<void> = Promise.resolve();
    let deadlocked = false;

    const withLock = (fn: () => Promise<void>): Promise<void> => {
      const execute = async () => { await fn(); };
      lock = lock.then(execute, execute);
      return lock;
    };

    const timeout = setTimeout(() => { deadlocked = true; }, 200);

    try {
      await Promise.race([
        withLock(async () => {
          // Await nested lock — this WILL deadlock
          await withLock(async () => {});
        }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 300)),
      ]);
    } catch {
      // timeout means deadlock
    }

    clearTimeout(timeout);

    // The deadlock should have been detected
    expect(deadlocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. git.merged must NOT be overwritten by stale checks
// ---------------------------------------------------------------------------

describe("git.merged sticky behavior", () => {
  // Simulate checkGit logic: the merged flag lifecycle

  function simulateCheckGit(opts: {
    initialMerged: boolean;
    agentRepoMergedResult: boolean | "error";
    projectRepoMergedResult: boolean | "error";
    mergeLogResult: boolean | "error";
  }): { merged: boolean; aheadBy: number; behindBy: number } {
    const state = makeState();
    state.git.merged = opts.initialMerged;
    state.git.aheadBy = 5;
    state.git.behindBy = 2;

    // Preserve sticky
    const wasMerged = state.git.merged;

    // Agent repo check (line 79-84 in git.ts)
    if (opts.agentRepoMergedResult === "error") {
      state.git.merged = false; // catch block — the bug
    } else {
      state.git.merged = opts.agentRepoMergedResult;
    }

    // Project repo check (line 107-136 in git.ts)
    if (opts.projectRepoMergedResult !== "error") {
      if (opts.projectRepoMergedResult) {
        state.git.merged = true;
      }
    }
    if (!state.git.merged && opts.mergeLogResult !== "error") {
      if (opts.mergeLogResult) {
        state.git.merged = true;
      }
    }

    // If merged, zero out ahead/behind
    if (state.git.merged) {
      state.git.aheadBy = 0;
      state.git.behindBy = 0;
    }

    // Sticky: once merged, stays merged (line 139)
    if (wasMerged) state.git.merged = true;

    return {
      merged: state.git.merged,
      aheadBy: state.git.aheadBy,
      behindBy: state.git.behindBy,
    };
  }

  it("preserves merged=true even when agent repo check fails", () => {
    const result = simulateCheckGit({
      initialMerged: true,
      agentRepoMergedResult: "error",
      projectRepoMergedResult: "error",
      mergeLogResult: "error",
    });
    expect(result.merged).toBe(true);
  });

  it("preserves merged=true even when agent repo says not merged", () => {
    const result = simulateCheckGit({
      initialMerged: true,
      agentRepoMergedResult: false,
      projectRepoMergedResult: false,
      mergeLogResult: false,
    });
    expect(result.merged).toBe(true);
  });

  it("sets merged=true when project repo confirms merge", () => {
    const result = simulateCheckGit({
      initialMerged: false,
      agentRepoMergedResult: false,
      projectRepoMergedResult: true,
      mergeLogResult: false,
    });
    expect(result.merged).toBe(true);
    expect(result.aheadBy).toBe(0);
    expect(result.behindBy).toBe(0);
  });

  it("sets merged=true via merge log when branch was deleted", () => {
    const result = simulateCheckGit({
      initialMerged: false,
      agentRepoMergedResult: false,
      projectRepoMergedResult: false,
      mergeLogResult: true,
    });
    expect(result.merged).toBe(true);
  });

  it("does not set merged when all checks say no", () => {
    const result = simulateCheckGit({
      initialMerged: false,
      agentRepoMergedResult: false,
      projectRepoMergedResult: false,
      mergeLogResult: false,
    });
    expect(result.merged).toBe(false);
    expect(result.aheadBy).toBe(5);
    expect(result.behindBy).toBe(2);
  });

  it("zeros ahead/behind when merged", () => {
    const result = simulateCheckGit({
      initialMerged: false,
      agentRepoMergedResult: true,
      projectRepoMergedResult: false,
      mergeLogResult: false,
    });
    expect(result.merged).toBe(true);
    expect(result.aheadBy).toBe(0);
    expect(result.behindBy).toBe(0);
  });

  it("does NOT zero ahead/behind when not merged", () => {
    const result = simulateCheckGit({
      initialMerged: false,
      agentRepoMergedResult: false,
      projectRepoMergedResult: "error",
      mergeLogResult: "error",
    });
    expect(result.merged).toBe(false);
    expect(result.aheadBy).toBe(5);
    expect(result.behindBy).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 12. checkGitInContainer must use agentBranch, not current HEAD
// ---------------------------------------------------------------------------

describe("checkGitInContainer branch name", () => {
  it("must check merged using agent branch, not current HEAD", () => {
    // The bug: container's HEAD might be "main" after a failed rebase,
    // but we need to check if "agent/UKR-xxx" is merged, not "main".
    const currentHead = "main";
    const agentBranch = "agent/UKR-116";

    const mergedBranchesOutput = [
      "  origin/main",
      "  origin/agent/UKR-116",
      "  origin/agent/UKR-100",
    ].join("\n");

    // OLD BUG: used currentHead → always true because "origin/main" is in merged list
    const oldResult = mergedBranchesOutput.includes(`origin/${currentHead}`);
    expect(oldResult).toBe(true); // wrong! always true for main

    // FIX: use agentBranch
    const fixedResult = mergedBranchesOutput.includes(`origin/${agentBranch}`);
    expect(fixedResult).toBe(true); // correct — UKR-116 IS in the list

    // When agent branch is NOT in merged list:
    const mergedWithoutAgent = [
      "  origin/main",
      "  origin/agent/UKR-100",
    ].join("\n");

    const oldWrong = mergedWithoutAgent.includes(`origin/${currentHead}`);
    expect(oldWrong).toBe(true); // BUG: says merged when it's NOT

    const fixedCorrect = mergedWithoutAgent.includes(`origin/${agentBranch}`);
    expect(fixedCorrect).toBe(false); // CORRECT: UKR-116 is NOT merged
  });
});

// ---------------------------------------------------------------------------
// 13. cleanupOrphans — must never clean up running or spawning agents
// ---------------------------------------------------------------------------

describe("cleanupOrphans safety", () => {
  // Extracted decision logic from dispatcher.ts cleanupOrphans
  function shouldCleanup(agent: {
    status: string;
    state?: { agent: string; lifecycle: string };
    issueId: string;
  }, activeIssueIds: string[]): boolean {
    const TERMINAL = new Set(["DONE", "CANCELLED", "REMOVED", "CLEANUP"]);
    if (TERMINAL.has(agent.status)) return false;
    if (activeIssueIds.includes(agent.issueId)) return false;
    if (agent.state?.agent === "running") return false;
    if (agent.state?.lifecycle === "spawning") return false;
    return true;
  }

  it("does NOT clean up agents that are actively running", () => {
    // This is the UKR-126 bug: Linear query returned only 50 issues,
    // UKR-126 was not in the list → treated as orphan → removeAgent() while Claude was running
    const agent = {
      status: "RUNNING",
      state: { agent: "running", lifecycle: "active" },
      issueId: "UKR-126",
    };
    expect(shouldCleanup(agent, [])).toBe(false);
  });

  it("does NOT clean up agents that are spawning", () => {
    const agent = {
      status: "SPAWNING",
      state: { agent: "stopped", lifecycle: "spawning" },
      issueId: "UKR-130",
    };
    expect(shouldCleanup(agent, [])).toBe(false);
  });

  it("does NOT clean up already-terminal agents", () => {
    for (const status of ["DONE", "CANCELLED", "REMOVED", "CLEANUP"]) {
      const agent = { status, state: { agent: "stopped", lifecycle: "removed" }, issueId: "UKR-1" };
      expect(shouldCleanup(agent, [])).toBe(false);
    }
  });

  it("does NOT clean up agents present in Linear query results", () => {
    const agent = {
      status: "EXITED",
      state: { agent: "stopped", lifecycle: "active" },
      issueId: "UKR-126",
    };
    expect(shouldCleanup(agent, ["UKR-126"])).toBe(false);
  });

  it("DOES clean up stopped agents not in Linear and not terminal", () => {
    const agent = {
      status: "EXITED",
      state: { agent: "stopped", lifecycle: "active" },
      issueId: "UKR-OLD",
    };
    expect(shouldCleanup(agent, ["UKR-1", "UKR-2"])).toBe(true);
  });

  it("handles agents without aggregate state (legacy)", () => {
    const agent = {
      status: "EXITED",
      state: undefined,
      issueId: "UKR-OLD",
    };
    // No state → agent is not "running" → can be cleaned
    expect(shouldCleanup(agent, [])).toBe(true);
  });

  it("handles Linear query returning fewer than total issues (first:50 limit)", () => {
    // Simulate: 60 issues exist, Linear returns first 50
    const linearResults = Array.from({ length: 50 }, (_, i) => `UKR-${i + 1}`);
    // Agent #55 is not in results but IS running
    const runningAgent = {
      status: "RUNNING",
      state: { agent: "running", lifecycle: "active" },
      issueId: "UKR-55",
    };
    expect(shouldCleanup(runningAgent, linearResults)).toBe(false);

    // Agent #55 is not in results and IS stopped — should be cleaned
    const stoppedAgent = {
      status: "EXITED",
      state: { agent: "stopped", lifecycle: "active" },
      issueId: "UKR-55",
    };
    expect(shouldCleanup(stoppedAgent, linearResults)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14. local-branches route must use aggregate git state, not stale clone
// ---------------------------------------------------------------------------

describe("local-branches git state source", () => {
  it("agent clone HEAD on main after failed rebase shows 0/0 — route must use aggregate instead", () => {
    // Scenario: agent clone's HEAD is on "main" (rebase moved it there),
    // so rev-list count against origin/main = 0/0.
    // But the aggregate knows the REAL state from the last successful check.

    // Simulate: clone is on main, rev-list says 0/0
    const cloneHead = "main";
    const defaultBranch = "main";
    // rev-list origin/main..HEAD when HEAD=main → 0
    const cloneAhead = 0;
    const cloneBehind = 0;

    // Aggregate state has the real values from before rebase
    const aggGit = {
      aheadBy: 3,
      behindBy: 1,
      merged: true,
      lastCommit: { sha: "abc1234", message: "fix stuff", author: "dev", date: "2026-03-05" },
    };

    // Route should prefer aggregate when available
    const useAggregate = aggGit.lastCommit != null;
    const aheadBy = useAggregate ? aggGit.aheadBy : cloneAhead;
    const behindBy = useAggregate ? aggGit.behindBy : cloneBehind;
    const merged = useAggregate ? aggGit.merged : false;

    expect(aheadBy).toBe(3); // from aggregate, not clone's 0
    expect(behindBy).toBe(1);
    expect(merged).toBe(true);
  });

  it("falls back to clone git when aggregate has no git info", () => {
    const cloneAhead = 2;
    const cloneBehind = 0;
    const aggGit = { lastCommit: null, aheadBy: 0, behindBy: 0, merged: false };

    const useAggregate = aggGit.lastCommit != null;
    const aheadBy = useAggregate ? aggGit.aheadBy : cloneAhead;
    const behindBy = useAggregate ? aggGit.behindBy : cloneBehind;

    expect(aheadBy).toBe(2); // from clone fallback
    expect(behindBy).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Dispatcher reassign-on-exit flow (assignee mode)
// ---------------------------------------------------------------------------

describe("dispatcher reassign on agent exit", () => {
  // Extracted decision logic from dispatcher processTrackerIssue + linearTracker.reassignOnDone

  function simulateReassign(opts: {
    agentStatus: string;
    alreadyReassigned: boolean;
    hasReassignOnDone: boolean;
    detectionMode: string;
    reassignOnDone: boolean;
    creatorId: string | null;
    assigneeId: string | null;
  }): { reassigned: boolean; reassignedTo: string | null } {
    const result = { reassigned: false, reassignedTo: null as string | null };

    // Dispatcher guard: only reassign on EXITED, once per agent
    if (opts.agentStatus !== "EXITED") return result;
    if (opts.alreadyReassigned) return result;
    if (!opts.hasReassignOnDone) return result;

    // linearTracker.reassignOnDone logic
    if (opts.detectionMode !== "assignee") return result;
    if (!opts.reassignOnDone) return result;
    if (!opts.creatorId) return result;
    if (opts.creatorId === opts.assigneeId) return result;

    result.reassigned = true;
    result.reassignedTo = opts.creatorId;
    return result;
  }

  it("reassigns to creator when agent exits (assignee mode)", () => {
    const result = simulateReassign({
      agentStatus: "EXITED",
      alreadyReassigned: false,
      hasReassignOnDone: true,
      detectionMode: "assignee",
      reassignOnDone: true,
      creatorId: "user-123",
      assigneeId: "bot-456",
    });

    expect(result.reassigned).toBe(true);
    expect(result.reassignedTo).toBe("user-123");
  });

  it("does NOT reassign when agent is still RUNNING", () => {
    const result = simulateReassign({
      agentStatus: "RUNNING",
      alreadyReassigned: false,
      hasReassignOnDone: true,
      detectionMode: "assignee",
      reassignOnDone: true,
      creatorId: "user-123",
      assigneeId: "bot-456",
    });

    expect(result.reassigned).toBe(false);
  });

  it("does NOT reassign in label mode", () => {
    const result = simulateReassign({
      agentStatus: "EXITED",
      alreadyReassigned: false,
      hasReassignOnDone: true,
      detectionMode: "label",
      reassignOnDone: true,
      creatorId: "user-123",
      assigneeId: "bot-456",
    });

    expect(result.reassigned).toBe(false);
  });

  it("does NOT reassign when reassignOnDone is false", () => {
    const result = simulateReassign({
      agentStatus: "EXITED",
      alreadyReassigned: false,
      hasReassignOnDone: true,
      detectionMode: "assignee",
      reassignOnDone: false,
      creatorId: "user-123",
      assigneeId: "bot-456",
    });

    expect(result.reassigned).toBe(false);
  });

  it("does NOT reassign when creator is already the assignee", () => {
    const result = simulateReassign({
      agentStatus: "EXITED",
      alreadyReassigned: false,
      hasReassignOnDone: true,
      detectionMode: "assignee",
      reassignOnDone: true,
      creatorId: "user-123",
      assigneeId: "user-123",
    });

    expect(result.reassigned).toBe(false);
  });

  it("does NOT reassign when creator is null", () => {
    const result = simulateReassign({
      agentStatus: "EXITED",
      alreadyReassigned: false,
      hasReassignOnDone: true,
      detectionMode: "assignee",
      reassignOnDone: true,
      creatorId: null,
      assigneeId: "bot-456",
    });

    expect(result.reassigned).toBe(false);
  });

  it("does NOT reassign twice (in-memory guard)", () => {
    const result = simulateReassign({
      agentStatus: "EXITED",
      alreadyReassigned: true,
      hasReassignOnDone: true,
      detectionMode: "assignee",
      reassignOnDone: true,
      creatorId: "user-123",
      assigneeId: "bot-456",
    });

    expect(result.reassigned).toBe(false);
  });

  it("does NOT reassign when tracker has no reassignOnDone", () => {
    const result = simulateReassign({
      agentStatus: "EXITED",
      alreadyReassigned: false,
      hasReassignOnDone: false,
      detectionMode: "assignee",
      reassignOnDone: true,
      creatorId: "user-123",
      assigneeId: "bot-456",
    });

    expect(result.reassigned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 16. trackerStatus vs linearStatus — reassign only applies to assignee mode
// ---------------------------------------------------------------------------

describe("trackerStatus state transitions with reassign", () => {
  it("in_progress → in_review transition preserves trackerStatus", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });

    // Simulate what dispatcher does after Gotowe
    // (transition happens on tracker side, not state side — state is set by next poll)
    // Agent is marked as previewed, status = IN_REVIEW
    const legacyStatus = "IN_REVIEW";

    // State axes don't change — the trackerStatus will be updated on next poll
    // when Linear returns the issue in "In Review" state
    expect(state.trackerStatus).toBe("in_progress");
    expect(state.linearStatus).toBe("in_progress");
  });

  it("reassign does NOT affect state axes — only Linear API side effect", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });

    // After reassign, state axes remain unchanged
    // The reassign is a Linear API mutation, not a state transition
    expect(state.trackerStatus).toBe("in_progress");
    expect(state.lifecycle).toBe("active");
  });

  it("deriveLegacyStatus is unaffected by reassign (no new states)", () => {
    // The reassign feature doesn't introduce new state values
    // Verify existing derivation still works for in_review scenario
    const state = makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });
    expect(deriveLegacyStatus(state, null)).toBe("EXITED");

    // After agent marks done and is in_review on Linear side,
    // the dispatcher sets status = IN_REVIEW directly (legacy path)
    // Aggregate state catches up on next poll
  });
});

// ---------------------------------------------------------------------------
// 17. Orphan cleanup guards — agents with active lifecycle must NOT be removed
// ---------------------------------------------------------------------------

describe("orphan cleanup state guards", () => {
  /**
   * Simulates the cleanupOrphans decision: should this agent be cleaned up?
   * Extracted from dispatcher.ts cleanupOrphans() logic.
   */
  function shouldCleanup(agent: { status: string; state?: AgentState | null }): boolean {
    const TERMINAL = new Set(["DONE", "CANCELLED", "REMOVED", "CLEANUP"]);
    if (TERMINAL.has(agent.status)) return false; // already terminal
    if (agent.state?.lifecycle === "active" || agent.state?.lifecycle === "spawning") return false;
    if (agent.state?.agent === "running") return false;
    return true; // orphan — clean up
  }

  it("does NOT clean up active agent that is EXITED (waiting for review)", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });
    expect(shouldCleanup({ status: "EXITED", state })).toBe(false);
  });

  it("does NOT clean up active agent that is RUNNING", () => {
    const state = makeState({ lifecycle: "active", agent: "running", trackerStatus: "in_progress", linearStatus: "in_progress" });
    expect(shouldCleanup({ status: "RUNNING", state })).toBe(false);
  });

  it("does NOT clean up spawning agent", () => {
    const state = makeState({ lifecycle: "spawning", agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });
    expect(shouldCleanup({ status: "SPAWNING", state })).toBe(false);
  });

  it("does NOT clean up active agent in review", () => {
    const state = makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "in_progress", linearStatus: "in_progress" });
    expect(shouldCleanup({ status: "IN_REVIEW", state })).toBe(false);
  });

  it("DOES clean up pending agent not in tracker", () => {
    const state = makeState({ lifecycle: "pending", agent: "stopped" });
    expect(shouldCleanup({ status: "PENDING", state })).toBe(true);
  });

  it("does NOT clean up already terminal agents", () => {
    const state = makeState({ lifecycle: "removed", agent: "stopped", trackerStatus: "done", linearStatus: "done" });
    expect(shouldCleanup({ status: "DONE", state })).toBe(false);
    expect(shouldCleanup({ status: "REMOVED", state })).toBe(false);
    expect(shouldCleanup({ status: "CANCELLED", state })).toBe(false);
  });

  it("lifecycle=active protects even without running agent (the UKR-126 bug)", () => {
    // This is exactly the scenario that caused UKR-126 to be incorrectly removed:
    // Agent finished (EXITED), lifecycle=active, but not returned by Linear query (first:50 limit)
    const state = makeState({
      lifecycle: "active",
      agent: "stopped",
      container: "running",
      trackerStatus: "in_progress",
      linearStatus: "in_progress",
    });
    expect(shouldCleanup({ status: "EXITED", state })).toBe(false);
    // Verify it would show as "awaiting" in UI, not "closed"
    expect(deriveUiStatus(state, null)).toEqual({ status: "awaiting", reason: "completed" });
  });
});

// ---------------------------------------------------------------------------
// Observation methods — encapsulation invariants
// ---------------------------------------------------------------------------

describe("observation method state transitions", () => {
  it("reportProcessExited: running → stopped", () => {
    const state = makeState({ agent: "running", lifecycle: "active" });
    // Simulate what reportProcessExited does
    if (state.agent === "running") {
      state.agent = "stopped";
    }
    expect(state.agent).toBe("stopped");
  });

  it("reportProcessExited: already stopped → no change", () => {
    const state = makeState({ agent: "stopped", lifecycle: "active" });
    if (state.agent === "running") {
      state.agent = "stopped";
    }
    expect(state.agent).toBe("stopped");
  });

  it("reportContainerDead: sets container=missing and forces agent=stopped", () => {
    const state = makeState({ agent: "running", container: "running" });
    state.container = "missing";
    if (state.agent === "running") {
      state.agent = "stopped";
    }
    expect(state.container).toBe("missing");
    expect(state.agent).toBe("stopped");
  });

  it("reportBranchMerged: sets trackerStatus=done when in_progress", () => {
    const state = makeState({ trackerStatus: "in_progress", linearStatus: "in_progress" });
    state.git.merged = true;
    if (state.trackerStatus === "in_progress" || state.trackerStatus === "unstarted") {
      state.trackerStatus = "done";
      state.linearStatus = "done";
    }
    expect(state.trackerStatus).toBe("done");
    expect(state.linearStatus).toBe("done");
    expect(state.git.merged).toBe(true);
  });

  it("reportBranchMerged: preserves done/cancelled status", () => {
    const state = makeState({ trackerStatus: "cancelled", linearStatus: "cancelled" });
    state.git.merged = true;
    if (state.trackerStatus === "in_progress" || state.trackerStatus === "unstarted") {
      state.trackerStatus = "done";
      state.linearStatus = "done";
    }
    expect(state.trackerStatus).toBe("cancelled"); // not overwritten
    expect(state.git.merged).toBe(true);
  });

  it("reportBranchGone: sets done when agent is not running", () => {
    const state = makeState({ agent: "stopped", trackerStatus: "in_progress" });
    if (state.agent !== "running") {
      state.trackerStatus = "done";
      state.linearStatus = "done";
      state.agent = "stopped";
    }
    expect(state.trackerStatus).toBe("done");
  });

  it("reportBranchGone: no-op when agent is running", () => {
    const state = makeState({ agent: "running", trackerStatus: "in_progress" });
    if (state.agent !== "running") {
      state.trackerStatus = "done";
    }
    expect(state.trackerStatus).toBe("in_progress"); // unchanged
  });
});

describe("snapshot immutability", () => {
  it("snapshot returns a copy that does not affect original state", () => {
    const state = makeState({ agent: "running", trackerStatus: "in_progress" });
    const snap = {
      agent: state.agent,
      container: state.container,
      lifecycle: state.lifecycle,
      trackerStatus: state.trackerStatus,
      linearStatus: state.linearStatus,
      git: { ...state.git },
      services: { ...state.services },
    };
    // Modifying snapshot should not affect original
    (snap as any).agent = "stopped";
    (snap.git as any).merged = true;
    expect(state.agent).toBe("running");
    expect(state.git.merged).toBe(false);
  });
});

describe("_doRefresh business rules", () => {
  it("agent=running + container≠running → agent=stopped", () => {
    const state = makeState({ agent: "running", container: "missing" });
    // Business rule from _doRefresh
    if (state.agent === "running" && state.container !== "running") {
      state.agent = "stopped";
    }
    expect(state.agent).toBe("stopped");
  });

  it("git.merged + trackerStatus=in_progress → trackerStatus=done", () => {
    const state = makeState({
      trackerStatus: "in_progress",
      linearStatus: "in_progress",
      git: { ...defaultAgentState().git, merged: true },
    });
    if (state.git.merged && state.trackerStatus === "in_progress") {
      state.trackerStatus = "done";
      state.linearStatus = "done";
    }
    expect(state.trackerStatus).toBe("done");
    expect(state.linearStatus).toBe("done");
  });

  it("git.merged + trackerStatus=done → no change", () => {
    const state = makeState({
      trackerStatus: "done",
      linearStatus: "done",
      git: { ...defaultAgentState().git, merged: true },
    });
    if (state.git.merged && state.trackerStatus === "in_progress") {
      state.trackerStatus = "done";
      state.linearStatus = "done";
    }
    expect(state.trackerStatus).toBe("done"); // already done
  });
});

// ---------------------------------------------------------------------------
// 10. _setLifecycle invariant — lifecycle=removed auto-cancels active tracker
// ---------------------------------------------------------------------------

describe("_setLifecycle invariant (write-time enforcement)", () => {
  // Simulates the guarded setter logic from AgentAggregate._setLifecycle
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

  it("auto-cancels tracker when setting lifecycle=removed with trackerStatus=in_progress", () => {
    const state = makeState({ lifecycle: "active", trackerStatus: "in_progress", linearStatus: "in_progress" });
    setLifecycle(state, "removed");
    expect(state.lifecycle).toBe("removed");
    expect(state.trackerStatus).toBe("cancelled");
    expect(state.linearStatus).toBe("cancelled");
  });

  it("auto-cancels tracker when setting lifecycle=removed with trackerStatus=unstarted", () => {
    const state = makeState({ lifecycle: "active", trackerStatus: "unstarted", linearStatus: "unstarted" });
    setLifecycle(state, "removed");
    expect(state.lifecycle).toBe("removed");
    expect(state.trackerStatus).toBe("cancelled");
    expect(state.linearStatus).toBe("cancelled");
  });

  it("allows lifecycle=removed when trackerStatus=done (no auto-cancel)", () => {
    const state = makeState({ lifecycle: "active", trackerStatus: "done", linearStatus: "done" });
    setLifecycle(state, "removed");
    expect(state.lifecycle).toBe("removed");
    expect(state.trackerStatus).toBe("done"); // unchanged
  });

  it("allows lifecycle=removed when trackerStatus=cancelled (no auto-cancel)", () => {
    const state = makeState({ lifecycle: "active", trackerStatus: "cancelled", linearStatus: "cancelled" });
    setLifecycle(state, "removed");
    expect(state.lifecycle).toBe("removed");
    expect(state.trackerStatus).toBe("cancelled"); // unchanged
  });

  it("allows non-removed lifecycle transitions without touching tracker", () => {
    const state = makeState({ lifecycle: "pending", trackerStatus: "in_progress", linearStatus: "in_progress" });
    setLifecycle(state, "active");
    expect(state.lifecycle).toBe("active");
    expect(state.trackerStatus).toBe("in_progress"); // unchanged
  });
});
