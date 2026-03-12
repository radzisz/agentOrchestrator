// ---------------------------------------------------------------------------
// Tests for uiStatus consistency — single source of truth guarantee
//
// These tests verify that ALL code paths that read/write agent uiStatus
// produce identical results. The invariant: uiStatus is ALWAYS derived by
// deriveUiStatus() from (state, currentOperation) — never stored independently.
//
// Scenarios tested:
//   1. saveAgent always persists the correctly derived uiStatus
//   2. getAgent returns uiStatus consistent with the agent's state
//   3. listAgents returns uiStatus consistent with getAgent for every agent
//   4. Disk fallback in getAgent returns consistent uiStatus
//   5. Cache mutations (cacheAgent → saveAgent) maintain consistency
//   6. State transitions don't leave stale uiStatus
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { AgentState, CurrentOperation, UiState } from "@/lib/agent-aggregate/types";
import { defaultAgentState, deriveUiStatus } from "@/lib/agent-aggregate/types";
import type { AgentData } from "@/lib/store";
import * as store from "@/lib/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let projectPath: string;

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return { ...defaultAgentState("agent/TEST-1"), ...overrides };
}

function makeAgent(overrides: Partial<AgentData> = {}): AgentData {
  const now = new Date().toISOString();
  return {
    issueId: "TEST-1",
    title: "Test Agent",
    status: "RUNNING",
    branch: "agent/TEST-1",
    servicesEnabled: false,
    spawned: true,
    previewed: false,
    notified: false,
    createdAt: now,
    updatedAt: now,
    state: makeState({ lifecycle: "active", agent: "running" }),
    currentOperation: null,
    ...overrides,
  };
}

/**
 * Write an agent config to disk in the expected directory structure.
 */
function writeAgentToDisk(issueId: string, data: AgentData): void {
  const configDir = join(projectPath, ".10timesdev", "agents", issueId, ".10timesdev");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(data, null, 2));
}

/**
 * Read agent config from disk.
 */
function readAgentFromDisk(issueId: string): AgentData | null {
  const cfgPath = join(projectPath, ".10timesdev", "agents", issueId, ".10timesdev", "config.json");
  if (!existsSync(cfgPath)) return null;
  return JSON.parse(readFileSync(cfgPath, "utf-8"));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "store-test-"));
  projectPath = tempDir;

  // Create workspace structure the store expects
  mkdirSync(join(tempDir, ".config"), { recursive: true });
  writeFileSync(
    join(tempDir, ".config", "config.json"),
    JSON.stringify({
      projects: [{ name: "test-project", path: projectPath }],
      integrations: {},
      nextPortSlot: 0,
    })
  );

  // Reset the store's in-memory caches
  store.invalidateCache();
});

afterEach(() => {
  store.invalidateCache();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. saveAgent always persists correctly derived uiStatus
// ---------------------------------------------------------------------------

describe("saveAgent persists derived uiStatus", () => {
  const stateScenarios: Array<{
    name: string;
    state: AgentState;
    op: CurrentOperation | null;
    expected: UiState;
  }> = [
    {
      name: "running agent",
      state: makeState({ lifecycle: "active", agent: "running" }),
      op: null,
      expected: { status: "running" },
    },
    {
      name: "stopped agent (awaiting)",
      state: makeState({ lifecycle: "active", agent: "stopped" }),
      op: null,
      expected: { status: "awaiting", reason: "completed" },
    },
    {
      name: "spawn in progress",
      state: makeState({ lifecycle: "spawning", agent: "stopped" }),
      op: { name: "spawn", startedAt: new Date().toISOString() },
      expected: { status: "starting" },
    },
    {
      name: "merge in progress",
      state: makeState({ lifecycle: "active", agent: "stopped" }),
      op: { name: "mergeAndClose", startedAt: new Date().toISOString() },
      expected: { status: "closing" },
    },
    {
      name: "tracker done → closed",
      state: makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "done", linearStatus: "done" }),
      op: null,
      expected: { status: "closed" },
    },
    {
      name: "lifecycle removed → closed",
      state: makeState({ lifecycle: "removed", agent: "stopped" }),
      op: null,
      expected: { status: "closed" },
    },
    {
      name: "rebase conflict → awaiting conflict",
      state: makeState({
        lifecycle: "active",
        agent: "stopped",
        git: { ...defaultAgentState().git, op: "rebasing" as const, rebaseConflict: true },
      }),
      op: null,
      expected: { status: "awaiting", reason: "conflict" },
    },
    {
      name: "error on pending → awaiting error",
      state: makeState({ lifecycle: "pending", agent: "stopped", lastError: "Something failed" }),
      op: null,
      expected: { status: "awaiting", reason: "error" },
    },
    {
      name: "transition to running → starting",
      state: makeState({
        lifecycle: "active",
        agent: "stopped",
        transition: { to: "running", startedAt: new Date().toISOString() },
      }),
      op: null,
      expected: { status: "starting" },
    },
    {
      name: "transition to stopped → closing",
      state: makeState({
        lifecycle: "active",
        agent: "running",
        transition: { to: "stopped", startedAt: new Date().toISOString() },
      }),
      op: null,
      expected: { status: "closing" },
    },
  ];

  for (const { name, state, op, expected } of stateScenarios) {
    it(`${name}: saveAgent sets uiStatus = ${JSON.stringify(expected)}`, () => {
      const agent = makeAgent({ state, currentOperation: op });
      store.saveAgent(projectPath, "TEST-1", agent);

      const retrieved = store.getAgent(projectPath, "TEST-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.uiStatus).toEqual(expected);

      // Verify it matches what deriveUiStatus would return
      const freshDerived = deriveUiStatus(state, op);
      expect(retrieved!.uiStatus).toEqual(freshDerived);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. getAgent and listAgents return IDENTICAL uiStatus
// ---------------------------------------------------------------------------

describe("getAgent and listAgents return identical uiStatus", () => {
  it("single agent — both return the same uiStatus", () => {
    const agent = makeAgent({
      state: makeState({ lifecycle: "active", agent: "stopped" }),
      currentOperation: null,
    });
    store.saveAgent(projectPath, "TEST-1", agent);

    const fromGet = store.getAgent(projectPath, "TEST-1");
    const fromList = store.listAgents(projectPath);

    expect(fromGet).not.toBeNull();
    expect(fromList).toHaveLength(1);
    expect(fromGet!.uiStatus).toEqual(fromList[0].uiStatus);
  });

  it("multiple agents with different states — each pair matches", () => {
    const agents: Array<{ id: string; state: AgentState; op: CurrentOperation | null }> = [
      { id: "A-1", state: makeState({ lifecycle: "active", agent: "running" }), op: null },
      { id: "A-2", state: makeState({ lifecycle: "active", agent: "stopped" }), op: null },
      { id: "A-3", state: makeState({ lifecycle: "removed", agent: "stopped" }), op: null },
      {
        id: "A-4",
        state: makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "done", linearStatus: "done" }),
        op: null,
      },
      {
        id: "A-5",
        state: makeState({ lifecycle: "spawning", agent: "stopped" }),
        op: { name: "spawn", startedAt: new Date().toISOString() },
      },
    ];

    for (const { id, state, op } of agents) {
      store.saveAgent(projectPath, id, makeAgent({ issueId: id, state, currentOperation: op }));
    }

    const list = store.listAgents(projectPath);
    expect(list).toHaveLength(agents.length);

    for (const { id, state, op } of agents) {
      const fromGet = store.getAgent(projectPath, id);
      const fromList = list.find((a) => a.issueId === id);
      const expected = deriveUiStatus(state, op);

      expect(fromGet!.uiStatus).toEqual(expected);
      expect(fromList!.uiStatus).toEqual(expected);
      expect(fromGet!.uiStatus).toEqual(fromList!.uiStatus);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. State transitions update uiStatus atomically
// ---------------------------------------------------------------------------

describe("state transitions update uiStatus atomically", () => {
  it("running → stopped: uiStatus changes from 'running' to 'awaiting'", () => {
    const agent = makeAgent({
      state: makeState({ lifecycle: "active", agent: "running" }),
    });
    store.saveAgent(projectPath, "TEST-1", agent);
    expect(store.getAgent(projectPath, "TEST-1")!.uiStatus).toEqual({ status: "running" });

    // Simulate agent stopping
    agent.state!.agent = "stopped";
    store.saveAgent(projectPath, "TEST-1", agent);
    expect(store.getAgent(projectPath, "TEST-1")!.uiStatus).toEqual({ status: "awaiting", reason: "completed" });

    // Verify listAgents agrees
    const list = store.listAgents(projectPath);
    const fromList = list.find((a) => a.issueId === "TEST-1");
    expect(fromList!.uiStatus).toEqual({ status: "awaiting", reason: "completed" });
  });

  it("awaiting → closed: trackerStatus changes to done", () => {
    const agent = makeAgent({
      state: makeState({ lifecycle: "active", agent: "stopped" }),
    });
    store.saveAgent(projectPath, "TEST-1", agent);
    expect(store.getAgent(projectPath, "TEST-1")!.uiStatus).toEqual({ status: "awaiting", reason: "completed" });

    // Simulate tracker closing
    agent.state!.trackerStatus = "done";
    agent.state!.linearStatus = "done";
    store.saveAgent(projectPath, "TEST-1", agent);

    const fromGet = store.getAgent(projectPath, "TEST-1")!;
    const fromList = store.listAgents(projectPath).find((a) => a.issueId === "TEST-1")!;
    expect(fromGet.uiStatus).toEqual({ status: "closed" });
    expect(fromList.uiStatus).toEqual({ status: "closed" });
  });

  it("starting → running → awaiting → closing → closed: full lifecycle", () => {
    const agent = makeAgent({
      issueId: "LIFE-1",
      state: makeState({ lifecycle: "spawning", agent: "stopped" }),
      currentOperation: { name: "spawn", startedAt: new Date().toISOString() },
    });

    // 1. Starting
    store.saveAgent(projectPath, "LIFE-1", agent);
    expect(store.getAgent(projectPath, "LIFE-1")!.uiStatus).toEqual({ status: "starting" });

    // 2. Running
    agent.state!.lifecycle = "active";
    agent.state!.agent = "running";
    agent.currentOperation = null;
    store.saveAgent(projectPath, "LIFE-1", agent);
    expect(store.getAgent(projectPath, "LIFE-1")!.uiStatus).toEqual({ status: "running" });

    // 3. Awaiting (agent stopped)
    agent.state!.agent = "stopped";
    store.saveAgent(projectPath, "LIFE-1", agent);
    expect(store.getAgent(projectPath, "LIFE-1")!.uiStatus).toEqual({ status: "awaiting", reason: "completed" });

    // 4. Closing (merge in progress)
    agent.currentOperation = { name: "mergeAndClose", startedAt: new Date().toISOString() };
    store.saveAgent(projectPath, "LIFE-1", agent);
    expect(store.getAgent(projectPath, "LIFE-1")!.uiStatus).toEqual({ status: "closing" });

    // 5. Closed (merge done, tracker done)
    agent.currentOperation = null;
    agent.state!.trackerStatus = "done";
    agent.state!.linearStatus = "done";
    agent.state!.lifecycle = "removed";
    store.saveAgent(projectPath, "LIFE-1", agent);
    expect(store.getAgent(projectPath, "LIFE-1")!.uiStatus).toEqual({ status: "closed" });

    // Verify listAgents reflects the final state
    const list = store.listAgents(projectPath);
    expect(list.find((a) => a.issueId === "LIFE-1")!.uiStatus).toEqual({ status: "closed" });
  });
});

// ---------------------------------------------------------------------------
// 4. cacheAgent → saveAgent: write-through consistency
// ---------------------------------------------------------------------------

describe("cacheAgent + saveAgent write-through", () => {
  it("cacheAgent makes agent visible in listAgents immediately", () => {
    const agent = makeAgent({ issueId: "CACHE-1" });
    store.cacheAgent(projectPath, "CACHE-1", agent);

    const list = store.listAgents(projectPath);
    expect(list.some((a) => a.issueId === "CACHE-1")).toBe(true);
  });

  it("cacheAgent followed by saveAgent: uiStatus is derived on save", () => {
    const agent = makeAgent({
      issueId: "CACHE-2",
      state: makeState({ lifecycle: "active", agent: "running" }),
    });

    // cacheAgent doesn't derive uiStatus
    store.cacheAgent(projectPath, "CACHE-2", agent);

    // saveAgent derives and persists uiStatus
    store.saveAgent(projectPath, "CACHE-2", agent);

    const retrieved = store.getAgent(projectPath, "CACHE-2");
    expect(retrieved!.uiStatus).toEqual({ status: "running" });
  });

  it("multiple saves with changing state: uiStatus always reflects latest", () => {
    const agent = makeAgent({ issueId: "MULTI-1" });

    // Save 1: running
    agent.state = makeState({ lifecycle: "active", agent: "running" });
    store.saveAgent(projectPath, "MULTI-1", agent);
    expect(store.getAgent(projectPath, "MULTI-1")!.uiStatus).toEqual({ status: "running" });

    // Save 2: stopped
    agent.state.agent = "stopped";
    store.saveAgent(projectPath, "MULTI-1", agent);
    expect(store.getAgent(projectPath, "MULTI-1")!.uiStatus).toEqual({ status: "awaiting", reason: "completed" });

    // Save 3: done
    agent.state.trackerStatus = "done";
    store.saveAgent(projectPath, "MULTI-1", agent);
    expect(store.getAgent(projectPath, "MULTI-1")!.uiStatus).toEqual({ status: "closed" });
  });
});

// ---------------------------------------------------------------------------
// 5. Disk fallback in getAgent returns consistent uiStatus
// ---------------------------------------------------------------------------

describe("getAgent disk fallback", () => {
  it("agent on disk but not in cache: getAgent loads and derives uiStatus", () => {
    // Write agent directly to disk (simulates external process creating agent)
    const agentData = makeAgent({
      issueId: "DISK-1",
      state: makeState({ lifecycle: "active", agent: "stopped" }),
      currentOperation: null,
    });
    // Remove uiStatus to test that getAgent derives it
    delete (agentData as any).uiStatus;
    writeAgentToDisk("DISK-1", agentData);

    // Ensure cache is loaded (without this agent)
    store.invalidateCache(projectPath);

    // getAgent should find it on disk via fallback
    const retrieved = store.getAgent(projectPath, "DISK-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.uiStatus).toEqual({ status: "awaiting", reason: "completed" });
  });

  it("disk fallback agent matches deriveUiStatus", () => {
    const state = makeState({ lifecycle: "removed", agent: "stopped" });
    const agentData = makeAgent({
      issueId: "DISK-2",
      state,
      currentOperation: null,
    });
    delete (agentData as any).uiStatus;
    writeAgentToDisk("DISK-2", agentData);

    store.invalidateCache(projectPath);

    const retrieved = store.getAgent(projectPath, "DISK-2");
    expect(retrieved!.uiStatus).toEqual(deriveUiStatus(state, null));
  });
});

// ---------------------------------------------------------------------------
// 6. deriveUiStatus edge cases for consistency
// ---------------------------------------------------------------------------

describe("deriveUiStatus edge cases", () => {
  it("operation takes priority over state-based derivation", () => {
    const state = makeState({
      lifecycle: "active",
      agent: "stopped",
      trackerStatus: "done",
      linearStatus: "done",
    });
    const op: CurrentOperation = { name: "mergeAndClose", startedAt: new Date().toISOString() };

    // Without op → closed
    expect(deriveUiStatus(state, null)).toEqual({ status: "closed" });
    // With op → closing
    expect(deriveUiStatus(state, op)).toEqual({ status: "closing" });
  });

  it("transition takes priority over operation", () => {
    const state = makeState({
      lifecycle: "active",
      agent: "stopped",
      transition: { to: "running", startedAt: new Date().toISOString() },
    });
    const op: CurrentOperation = { name: "mergeAndClose", startedAt: new Date().toISOString() };

    // Transition to=running → starting, regardless of operation
    expect(deriveUiStatus(state, op)).toEqual({ status: "starting" });
  });

  it("agent running always shows 'running' regardless of lifecycle/tracker", () => {
    const combos = [
      { lifecycle: "removed" as const, trackerStatus: "done" as const },
      { lifecycle: "removed" as const, trackerStatus: "cancelled" as const },
      { lifecycle: "active" as const, trackerStatus: "done" as const },
      { lifecycle: "active" as const, trackerStatus: "in_progress" as const },
    ];

    for (const combo of combos) {
      const state = makeState({
        ...combo,
        agent: "running",
        linearStatus: combo.trackerStatus,
      });
      expect(deriveUiStatus(state, null).status).toBe("running");
    }
  });

  it("cancelled tracker: same as done — shows closed", () => {
    const state = makeState({
      lifecycle: "active",
      agent: "stopped",
      trackerStatus: "cancelled",
      linearStatus: "cancelled",
    });
    expect(deriveUiStatus(state, null)).toEqual({ status: "closed" });
  });
});

// ---------------------------------------------------------------------------
// 7. Invariant: ALL read paths return the SAME uiStatus for same agent
// ---------------------------------------------------------------------------

describe("single source of truth invariant", () => {
  const scenarios: Array<{
    name: string;
    state: AgentState;
    op: CurrentOperation | null;
  }> = [
    { name: "running", state: makeState({ lifecycle: "active", agent: "running" }), op: null },
    { name: "awaiting", state: makeState({ lifecycle: "active", agent: "stopped" }), op: null },
    { name: "closed (done)", state: makeState({ lifecycle: "active", agent: "stopped", trackerStatus: "done", linearStatus: "done" }), op: null },
    { name: "closed (removed)", state: makeState({ lifecycle: "removed", agent: "stopped" }), op: null },
    { name: "starting (spawn)", state: makeState({ lifecycle: "spawning" }), op: { name: "spawn", startedAt: "" } },
    { name: "closing (merge)", state: makeState({ lifecycle: "active" }), op: { name: "mergeAndClose", startedAt: "" } },
    {
      name: "awaiting conflict",
      state: makeState({
        lifecycle: "active",
        agent: "stopped",
        git: { ...defaultAgentState().git, op: "rebasing" as const, rebaseConflict: true },
      }),
      op: null,
    },
    { name: "awaiting error", state: makeState({ lifecycle: "pending", lastError: "fail" }), op: null },
  ];

  for (const { name, state, op } of scenarios) {
    it(`${name}: getAgent, listAgents, and deriveUiStatus all agree`, () => {
      const agent = makeAgent({ issueId: "INV-1", state, currentOperation: op });
      store.saveAgent(projectPath, "INV-1", agent);

      const canonical = deriveUiStatus(state, op);
      const fromGet = store.getAgent(projectPath, "INV-1")!.uiStatus;
      const fromList = store.listAgents(projectPath).find((a) => a.issueId === "INV-1")!.uiStatus;

      expect(fromGet).toEqual(canonical);
      expect(fromList).toEqual(canonical);

      // Clean up for next iteration
      store.invalidateCache(projectPath);
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Cache invalidation: after invalidateCache, fresh data from disk
// ---------------------------------------------------------------------------

describe("cache invalidation", () => {
  it("invalidateCache(projectPath) forces re-read from disk", async () => {
    const agent = makeAgent({
      issueId: "INV-CACHE-1",
      state: makeState({ lifecycle: "active", agent: "running" }),
    });
    store.saveAgent(projectPath, "INV-CACHE-1", agent);
    expect(store.getAgent(projectPath, "INV-CACHE-1")!.uiStatus).toEqual({ status: "running" });

    // Flush pending writes so the file is on disk
    await store.flushAll();

    // Modify disk directly (simulating external process update)
    const diskAgent = readAgentFromDisk("INV-CACHE-1")!;
    diskAgent.state!.agent = "stopped";
    diskAgent.state!.trackerStatus = "done";
    diskAgent.state!.linearStatus = "done";
    diskAgent.uiStatus = { status: "closed" };
    writeAgentToDisk("INV-CACHE-1", diskAgent);

    // Before invalidation: cache still has old data
    expect(store.getAgent(projectPath, "INV-CACHE-1")!.uiStatus).toEqual({ status: "running" });

    // After invalidation: reads from disk
    store.invalidateCache(projectPath);
    const fresh = store.getAgent(projectPath, "INV-CACHE-1")!;
    expect(fresh.uiStatus).toEqual({ status: "closed" });
  });
});

// ---------------------------------------------------------------------------
// 9. getAgent deep clones — mutations don't corrupt cache
// ---------------------------------------------------------------------------

describe("getAgent returns deep clone", () => {
  it("mutating getAgent result does not affect subsequent calls", () => {
    const agent = makeAgent({
      state: makeState({ lifecycle: "active", agent: "running" }),
    });
    store.saveAgent(projectPath, "TEST-1", agent);

    const first = store.getAgent(projectPath, "TEST-1")!;
    expect(first.uiStatus).toEqual({ status: "running" });

    // Mutate the returned object
    first.uiStatus = { status: "closed" };
    first.state!.agent = "stopped";

    // Second call should return original data, not the mutated version
    const second = store.getAgent(projectPath, "TEST-1")!;
    expect(second.uiStatus).toEqual({ status: "running" });
  });
});
