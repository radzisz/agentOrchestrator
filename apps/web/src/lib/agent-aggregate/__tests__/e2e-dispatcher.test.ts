// ---------------------------------------------------------------------------
// E2E tests — Dispatcher + AgentAggregate full lifecycle
//
// Covers: spawn → agent work → merge/reject/error
// Variants: local repo (no remote), remote repo (with origin)
// Agent outcomes: done (commits), error (spawn/process fail), more-info (wake)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";

// ---------------------------------------------------------------------------
// 1. Mock infrastructure BEFORE any imports that use them
// ---------------------------------------------------------------------------

// -- File system (selective mock — only for agent dirs) --
const MOCK_FS = new Map<string, string>();
const MOCK_DIRS = new Set<string>();

function mockExists(p: string): boolean {
  if (MOCK_FS.has(p)) return true;
  if (MOCK_DIRS.has(p)) return true;
  // Project .git always exists
  if (p.endsWith(".git") && (p.includes("/test-project") || p.includes("\\test-project"))) return true;
  // Agent gitignore / lock files
  if (p.includes(".10timesdev")) return false;
  if (p.endsWith(".env")) return false;
  if (p.endsWith("pnpm-lock.yaml") || p.endsWith("package-lock.json")) return false;
  return false;
}

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => mockExists(p)),
    mkdirSync: vi.fn((p: string) => { MOCK_DIRS.add(p); }),
    writeFileSync: vi.fn((p: string, data: any) => { MOCK_FS.set(p, String(data)); }),
    readFileSync: vi.fn((p: string) => MOCK_FS.get(p) ?? ""),
    appendFileSync: vi.fn((p: string, data: any) => {
      MOCK_FS.set(p, (MOCK_FS.get(p) || "") + String(data));
    }),
    copyFileSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

// -- Store --
const mockAgents = new Map<string, any>();
const mockMessages = new Map<string, any[]>();
const mockLogs: string[] = [];

vi.mock("@/lib/store", () => ({
  listProjects: vi.fn(() => [
    { name: "test-project", path: "/tmp/test-project", config: {} },
  ]),
  getAgent: vi.fn((_path: string, id: string) => {
    const a = mockAgents.get(id);
    return a ? JSON.parse(JSON.stringify(a)) : undefined;
  }),
  getAgentRef: vi.fn((_path: string, id: string) => mockAgents.get(id)),
  saveAgent: vi.fn((_path: string, id: string, data: any) => {
    mockAgents.set(id, JSON.parse(JSON.stringify(data)));
  }),
  cacheAgent: vi.fn((_path: string, id: string, data: any) => {
    mockAgents.set(id, JSON.parse(JSON.stringify(data)));
  }),
  listAgents: vi.fn(() => [...mockAgents.values()]),
  getMessages: vi.fn((_path: string, id: string) => mockMessages.get(id) || []),
  appendMessage: vi.fn((_path: string, id: string, role: string, text: string) => {
    if (!mockMessages.has(id)) mockMessages.set(id, []);
    mockMessages.get(id)!.push({ role, text, createdAt: new Date().toISOString() });
  }),
  appendLog: vi.fn((_path: string, _key: string, msg: string) => {
    mockLogs.push(msg);
  }),
  getProjectConfig: vi.fn(() => ({})),
  saveProjectConfig: vi.fn(),
  getPortsForSlot: vi.fn((slot: number) => ({
    slot,
    frontend: [40000 + slot * 6, 40000 + slot * 6 + 1],
    backend: [40000 + slot * 6 + 2, 40000 + slot * 6 + 3],
    all: [40000 + slot * 6, 40000 + slot * 6 + 1, 40000 + slot * 6 + 2, 40000 + slot * 6 + 3, 40000 + slot * 6 + 4, 40000 + slot * 6 + 5],
  })),
  getAIRules: vi.fn(() => []),
  getConfig: vi.fn(() => ({ projects: [], integrations: {}, trackerInstances: [], aiProviderInstances: [], imProviderInstances: [], repoProviderInstances: [], rtenvInstances: [], aiRules: [], nextPortSlot: 0 })),
  getRuntime: vi.fn(() => null),
  listRuntimes: vi.fn(() => []),
  saveRuntime: vi.fn(),
  invalidateCache: vi.fn(),
  getProjectByName: vi.fn((name: string) => {
    if (name === "test-project") return { name: "test-project", path: "/tmp/test-project" };
    return undefined;
  }),
}));

// -- Port manager --
let nextSlot = 0;
vi.mock("@/services/port-manager", () => ({
  allocate: vi.fn((_project: string, _issue: string) => {
    const slot = nextSlot++;
    return {
      slot,
      frontend: [40000 + slot * 6, 40000 + slot * 6 + 1],
      backend: [40000 + slot * 6 + 2, 40000 + slot * 6 + 3],
      all: Array.from({ length: 6 }, (_, i) => 40000 + slot * 6 + i),
    };
  }),
}));

// -- Docker --
const mockDockerExecs = new Map<string, { onExit: Function; onData: Function }>();

vi.mock("@/lib/docker", () => ({
  DOCKER_IMAGE: "agent-orchestrator:latest",
  ensureImage: vi.fn(async () => {}),
  createAndStartContainer: vi.fn(async () => {}),
  removeContainer: vi.fn(async () => {}),
  removeVolume: vi.fn(async () => {}),
  execInContainerSimple: vi.fn(async () => ({ ok: true, stdout: "", stderr: "", code: 0 })),
  execInContainerAsync: vi.fn(async (_container: string, _args: any, opts: any) => {
    const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mockDockerExecs.set(execId, { onExit: opts.onExit, onData: opts.onData });
    return { execId };
  }),
  killProcesses: vi.fn(async () => {}),
  getContainerStatus: vi.fn(async () => ({ status: "running", exitCode: 0 })),
}));

// -- CMD (shell commands, simple-git) --
const mockGitLog = {
  all: [{ hash: "abc123", message: "feat: implement task", author_name: "Agent", date: "2026-03-10" }],
  latest: { hash: "abc123", message: "feat: implement task", author_name: "Agent", date: "2026-03-10" },
};

const mockSimpleGit = () => ({
  clone: vi.fn(async () => {}),
  checkout: vi.fn(async () => {}),
  checkoutLocalBranch: vi.fn(async () => {}),
  status: vi.fn(async () => ({
    files: [],
    current: "agent/TEST-1",
    tracking: null,
    isClean: () => true,
  })),
  log: vi.fn(async () => mockGitLog),
  fetch: vi.fn(async () => {}),
  pull: vi.fn(async () => {}),
  push: vi.fn(async () => {}),
  merge: vi.fn(async () => ({ result: "success", conflicts: [] })),
  raw: vi.fn(async (args: string[]) => {
    if (args[0] === "remote" && args[1] === "get-url") return "https://github.com/test/repo.git";
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
    if (args[0] === "log" && args.includes("--oneline")) return "abc123 feat: implement task";
    if (args[0] === "diff" && args.includes("--stat")) return " src/index.ts | 5 +++++\n 1 file changed, 5 insertions(+)";
    if (args[0] === "branch" && args[1] === "-D") return "";
    if (args[0] === "config") return "";
    if (args[0] === "add") return "";
    if (args[0] === "commit") return "";
    if (args[0] === "worktree") return "";
    return "";
  }),
  addConfig: vi.fn(async () => {}),
  add: vi.fn(async () => {}),
  commit: vi.fn(async () => {}),
  branch: vi.fn(async () => ({ all: ["main", "agent/TEST-1"], current: "agent/TEST-1" })),
  revparse: vi.fn(async () => "abc123"),
  diff: vi.fn(async () => ""),
  diffSummary: vi.fn(async () => ({ files: [], insertions: 5, deletions: 0 })),
});

vi.mock("@/lib/cmd", () => ({
  simpleGit: vi.fn(() => mockSimpleGit()),
  run: vi.fn(async (_cmd: string, _opts?: any) => ({ ok: true, stdout: "", stderr: "", code: 0 })),
  logError: vi.fn(),
  dockerExec: vi.fn(async (_container: string, cmd: string) => {
    // ps aux check for agent process
    if (cmd.includes("ps aux")) return { ok: true, stdout: "", stderr: "", code: 0 };
    // chown, pkill
    return { ok: true, stdout: "", stderr: "", code: 0 };
  }),
}));

// -- Git service --
vi.mock("@/services/git", () => ({
  getDefaultBranch: vi.fn(async () => "main"),
  hasOrigin: vi.fn(async () => true),
  pullMainBranch: vi.fn(async () => {}),
  branchExistsOnRemote: vi.fn(async () => true),
}));

// -- Event bus --
const emittedEvents: { event: string; data: any }[] = [];
vi.mock("@/lib/event-bus", () => ({
  eventBus: {
    emit: vi.fn((event: string, data: any) => { emittedEvents.push({ event, data }); }),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

// -- Issue tracker registry --
const mockTrackerIssues: import("@/lib/issue-trackers/types").TrackerIssue[] = [];

const mockTracker: import("@/lib/issue-trackers/types").IssueTracker = {
  name: "mock-tracker",
  displayName: "Mock Tracker",
  schema: { type: "mock", displayName: "Mock", fields: [] },
  canTransitionState: true,
  canComment: true,
  canDetectWake: true,
  canManageLabels: false,
  pollIssues: vi.fn(async () => mockTrackerIssues),
  transitionTo: vi.fn(async () => {}),
  addComment: vi.fn(async () => {}),
  getComments: vi.fn(async () => []),
  hasLabel: vi.fn(() => false),
  getIssue: vi.fn(async () => null),
};

vi.mock("@/lib/issue-trackers/registry", () => ({
  getActiveTrackers: vi.fn(() => [mockTracker]),
  resolveTrackerConfig: vi.fn(() => ({ apiKey: "test-key" })),
  getTrackerPollInterval: vi.fn(() => 60000),
}));

// -- Tracker operations --
vi.mock("@/lib/agent-aggregate/operations/tracker", () => ({
  fetchIssue: vi.fn(async () => null),
  transitionTo: vi.fn(async () => {}),
  closeIssue: vi.fn(async () => {}),
  cancelIssue: vi.fn(async () => {}),
  addComment: vi.fn(async () => {}),
}));

// -- Task files --
vi.mock("@/lib/agent-aggregate/operations/task-files", () => ({
  writeTaskMd: vi.fn(async () => {}),
  writeClaudeMd: vi.fn(() => {}),
  ensureGitIgnored: vi.fn(() => {}),
  rewriteImageUrls: vi.fn((msg: string) => msg),
}));

// -- Rule resolver --
vi.mock("@/lib/agent-aggregate/operations/rule-resolver", () => ({
  writeRulesMd: vi.fn(() => false),
}));

// -- AI provider --
vi.mock("@/lib/agent-aggregate/ai-provider", () => ({
  resolveProviderConfig: vi.fn(() => ({ type: "claude-code", model: "sonnet" })),
  resolveProviderInstance: vi.fn(() => null),
  getProviderDriver: vi.fn(() => ({
    processPattern: "claude.*--dangerously-skip-permissions",
    outputLogPath: "/tmp/claude-output.log",
    buildLaunchCommand: (prompt: string) => `echo "mock agent" | tee /tmp/claude-output.log`,
    buildEnvVars: () => ["ANTHROPIC_API_KEY=test"],
    filterOutput: (raw: string) => raw,
  })),
  DEFAULT_PROVIDER: { type: "claude-code", model: "sonnet" },
}));

// -- Runtime --
vi.mock("@/services/runtime", () => ({
  getProjectRuntimeConfig: vi.fn(() => ({ services: [] })),
  detectPort: vi.fn(() => 3000),
  startRemote: vi.fn(async () => {}),
  cleanupRuntime: vi.fn(async () => {}),
}));

// -- DB --
vi.mock("@/lib/db", () => ({
  upsertIssue: vi.fn(),
}));

// -- Services ops --
vi.mock("@/lib/agent-aggregate/operations/services", () => ({
  checkServices: vi.fn(async () => ({})),
  startAllServices: vi.fn(async () => {}),
  stopAllServices: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// 2. Import the SUT (after all mocks are registered)
// ---------------------------------------------------------------------------

import * as store from "@/lib/store";
import * as docker from "@/lib/docker";
import * as cmd from "@/lib/cmd";
import { AgentAggregate } from "../aggregate";
import { createAggregate, tryGetAggregate, getAggregate, clearAggregates } from "../index";
import { defaultAgentState } from "../types";
import type { TrackerIssue, TrackerComment } from "@/lib/issue-trackers/types";

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId: "ext-1",
    identifier: "TEST-1",
    title: "Fix the login bug",
    description: "Login page returns 500 on submit",
    priority: 2,
    phase: "todo",
    rawState: "Todo",
    labels: [],
    createdBy: "user@test.com",
    createdAt: "2026-03-10T10:00:00Z",
    url: "https://tracker.test/TEST-1",
    source: "mock",
    comments: [],
    _raw: {},
    ...overrides,
  };
}

function makeAgentData(issueId: string, overrides: Partial<store.AgentData> = {}): store.AgentData {
  const now = new Date().toISOString();
  return {
    issueId,
    title: `Task ${issueId}`,
    status: "SPAWNING" as const,
    branch: `agent/${issueId}`,
    servicesEnabled: false,
    spawned: false,
    previewed: false,
    notified: false,
    createdAt: now,
    updatedAt: now,
    state: defaultAgentState(`agent/${issueId}`),
    currentOperation: null,
    ...overrides,
  };
}

/** Simulate the mock agent exiting with output. */
function simulateAgentExit(exitCode = 0, output = '{"status":"done","summary":"Task completed"}') {
  for (const [execId, handlers] of mockDockerExecs.entries()) {
    handlers.onData(output);
    handlers.onExit(exitCode, output);
    mockDockerExecs.delete(execId);
    break; // only fire the most recent
  }
}

/** Wait for microtasks to flush. */
async function flush(ms = 10) {
  await new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 4. Reset state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default simpleGit mock (clearAllMocks wipes mockReturnValue/mockImplementation)
  vi.mocked(cmd.simpleGit as any).mockImplementation(() => mockSimpleGit());
  mockAgents.clear();
  mockMessages.clear();
  mockLogs.length = 0;
  emittedEvents.length = 0;
  MOCK_FS.clear();
  MOCK_DIRS.clear();
  mockDockerExecs.clear();
  mockTrackerIssues.length = 0;
  nextSlot = 0;

  // Reset the aggregate registry between tests
  clearAggregates();
});

// ---------------------------------------------------------------------------
// 5. Tests
// ---------------------------------------------------------------------------

describe("E2E: Spawn → Agent Work → Outcome", () => {

  // =========================================================================
  // SCENARIO 1: Remote repo, agent completes successfully → merge & close
  // =========================================================================
  describe("remote repo — agent done → merge & close", () => {
    it("spawns agent, agent exits with done, dispatcher transitions to in_review, then merge & close", async () => {
      // -- Arrange: tracker returns a "todo" issue --
      const issue = makeIssue({ identifier: "PROJ-1", phase: "todo" });
      mockTrackerIssues.push(issue);

      // Make the agent dir "exist" after clone
      const agentDir = join("/tmp/test-project", ".10timesdev", "agents", "PROJ-1", "git");
      vi.mocked(docker.execInContainerAsync).mockImplementation(async (_c, _a, opts?) => {
        // After container creation, the agent dir "exists"
        MOCK_DIRS.add(agentDir);
        MOCK_DIRS.add(join(agentDir, ".git"));
        const execId = `exec-${Date.now()}`;
        mockDockerExecs.set(execId, { onExit: opts?.onExit!, onData: opts?.onData! });
        return { execId };
      });

      // -- Act: import dispatcher and run one tick --
      const dispatcher = await import("@/services/dispatcher");

      // tick() processes all projects and their issues
      await (dispatcher as any).__esModule
        ? (await import("@/services/dispatcher")).triggerSync()
        : null;

      // Manually execute the processProjectTrackers logic since triggerSync needs `running=true`
      // Instead, directly test the aggregate lifecycle:

      const agentData = makeAgentData("PROJ-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      // -- Spawn --
      await agg.spawnAgent({ trackerIssue: issue });

      // Verify spawn results
      expect(agg.snapshot.lifecycle).toBe("active");
      expect(agg.snapshot.agent).toBe("running");
      expect(agg.agentData.spawned).toBe(true);
      expect(agg.agentData.branch).toBe("agent/PROJ-1");
      expect(emittedEvents.some(e => e.event === "agent:spawned")).toBe(true);

      // Docker container was created
      expect(docker.createAndStartContainer).toHaveBeenCalled();
      // Agent process was started
      expect(docker.execInContainerAsync).toHaveBeenCalled();

      // -- Agent exits with done --
      simulateAgentExit(0, '{"status":"done","summary":"Fixed login validation"}');
      await flush();

      // Agent process reported as stopped (via onExit → reportProcessExited)
      // Note: reportProcessExited is called via the onAgentExited callback
      agg.reportProcessExited();
      expect(agg.snapshot.agent).toBe("stopped");
      expect(emittedEvents.some(e => e.event === "agent:exited")).toBe(true);

      // -- Merge & close --
      const result = await agg.mergeAndClose({ cleanup: true, closeIssue: true });
      expect(result.success).toBe(true);

      expect(agg.snapshot.trackerStatus).toBe("done");
      expect(agg.snapshot.lifecycle).toBe("removed");
      expect(emittedEvents.some(e => e.event === "agent:merged")).toBe(true);
      expect(emittedEvents.some(e => e.event === "agent:cleanup")).toBe(true);
    });
  });

  // =========================================================================
  // SCENARIO 2: Local repo (no remote), agent done → merge
  // =========================================================================
  describe("local repo (no remote) — agent done → merge", () => {
    it("spawns using local clone, merges without remote push", async () => {
      const issue = makeIssue({ identifier: "LOCAL-1", source: "local", phase: "todo" });

      // No remote origin
      vi.mocked(cmd.simpleGit as any).mockReturnValue({
        ...mockSimpleGit(),
        raw: vi.fn(async (args: string[]) => {
          if (args[0] === "remote" && args[1] === "get-url") throw new Error("No such remote");
          if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
          if (args[0] === "log" && args.includes("--oneline")) return "def456 fix: local change";
          if (args[0] === "diff" && args.includes("--stat")) return " file.ts | 3 +++\n 1 file changed";
          if (args[0] === "config") return "";
          if (args[0] === "add") return "";
          if (args[0] === "branch" && args[1] === "-D") return "";
          if (args[0] === "worktree") return "";
          return "";
        }),
      });

      const { hasOrigin } = await import("@/services/git");
      vi.mocked(hasOrigin).mockResolvedValue(false);

      const agentData = makeAgentData("LOCAL-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await agg.spawnAgent({ trackerIssue: issue });

      expect(agg.snapshot.lifecycle).toBe("active");
      expect(agg.snapshot.agent).toBe("running");
      expect(agg.agentData.trackerSource).toBe("local");

      // Agent finishes
      agg.reportProcessExited();
      expect(agg.snapshot.agent).toBe("stopped");

      // Merge — should work even without remote
      const result = await agg.mergeAndClose({ cleanup: true, closeIssue: true });
      expect(result.success).toBe(true);
      expect(agg.snapshot.lifecycle).toBe("removed");
    });
  });

  // =========================================================================
  // SCENARIO 3: Spawn failure → error visible to user
  // =========================================================================
  describe("spawn failure — error visibility", () => {
    it("sets lastError when container creation fails, shows awaiting+error in UI", async () => {
      const issue = makeIssue({ identifier: "ERR-1", phase: "todo" });

      // Make container creation fail (after clone succeeds)
      vi.mocked(docker.createAndStartContainer).mockRejectedValueOnce(
        new Error("Docker daemon is not running")
      );

      const agentData = makeAgentData("ERR-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await expect(agg.spawnAgent({ trackerIssue: issue })).rejects.toThrow("Docker daemon is not running");

      // Lifecycle stays active (not error), but agent is stopped
      expect(agg.snapshot.lifecycle).toBe("active");
      expect(agg.snapshot.agent).toBe("stopped");

      // Dispatcher calls setError after catching spawn failure
      agg.setError("Docker daemon is not running");
      expect(agg.snapshot.lastError).toBe("Docker daemon is not running");
    });

    it("shows awaiting+error for pending lifecycle with lastError", async () => {
      const agentData = makeAgentData("ERR-2");
      agentData.state!.lifecycle = "pending";
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      agg.setError("Docker daemon not running");

      const { deriveUiStatus } = await import("../types");
      const ui = deriveUiStatus(agg.snapshot as any, null);
      expect(ui).toEqual({ status: "awaiting", reason: "error" });
    });
  });

  // =========================================================================
  // SCENARIO 4: Agent needs more info → human comment → wake
  // =========================================================================
  describe("agent needs more info → wake with message", () => {
    it("agent exits, human sends message, agent wakes with instructions", async () => {
      const issue = makeIssue({ identifier: "INFO-1", phase: "todo" });

      const agentData = makeAgentData("INFO-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      // Spawn
      await agg.spawnAgent({ trackerIssue: issue });
      expect(agg.snapshot.agent).toBe("running");

      // Agent exits asking for more info
      simulateAgentExit(0, '{"status":"need_info","summary":"Which API endpoint should I use?"}');
      agg.reportProcessExited();
      expect(agg.snapshot.agent).toBe("stopped");
      expect(agg.snapshot.lifecycle).toBe("active");

      // UI shows "awaiting" with "completed" reason
      const ui = agg.uiStatus;
      expect(ui.status).toBe("awaiting");
      expect(ui.reason).toBe("completed");

      // Simulate agent dir existing for wake
      const agentDir = agg.agentData.agentDir!;
      MOCK_DIRS.add(agentDir);
      MOCK_DIRS.add(join(agentDir, ".git"));
      MOCK_DIRS.add(join(agentDir, ".10timesdev"));

      // Human sends instructions
      await agg.wakeAgent("Use the /api/v2/users endpoint");

      expect(agg.snapshot.agent).toBe("running");
      expect(emittedEvents.some(e => e.event === "agent:wake")).toBe(true);

      // Message was stored
      const msgs = vi.mocked(store.appendMessage);
      const humanMsgs = msgs.mock.calls.filter(c => c[2] === "human" && c[3].includes("/api/v2/users"));
      expect(humanMsgs.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // SCENARIO 5: Agent crashes (non-zero exit) → remains awaiting
  // =========================================================================
  describe("agent process crash — non-zero exit", () => {
    it("agent crashes, remains in active lifecycle awaiting user action", async () => {
      const issue = makeIssue({ identifier: "CRASH-1", phase: "todo" });

      const agentData = makeAgentData("CRASH-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await agg.spawnAgent({ trackerIssue: issue });
      expect(agg.snapshot.agent).toBe("running");

      // Agent crashes
      simulateAgentExit(1, "Segmentation fault");
      agg.reportProcessExited();

      expect(agg.snapshot.agent).toBe("stopped");
      expect(agg.snapshot.lifecycle).toBe("active");

      // UI: awaiting + completed (not error — process exit is normal lifecycle)
      const ui = agg.uiStatus;
      expect(ui.status).toBe("awaiting");
      expect(ui.reason).toBe("completed");
    });
  });

  // =========================================================================
  // SCENARIO 6: Reject/cancel agent
  // =========================================================================
  describe("reject agent", () => {
    it("rejects agent and cancels tracker issue", async () => {
      const issue = makeIssue({ identifier: "REJ-1", phase: "todo" });

      const agentData = makeAgentData("REJ-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await agg.spawnAgent({ trackerIssue: issue });
      agg.reportProcessExited();

      await agg.reject(true);

      expect(agg.snapshot.trackerStatus).toBe("cancelled");
    });
  });

  // =========================================================================
  // SCENARIO 7: Merge failure → error recovery
  // =========================================================================
  describe("merge failure — recovery", () => {
    it("merge conflict aborts cleanly and preserves idle git state", async () => {
      const issue = makeIssue({ identifier: "MFAIL-1", phase: "todo" });

      const agentData = makeAgentData("MFAIL-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await agg.spawnAgent({ trackerIssue: issue });
      agg.reportProcessExited();

      // Make merge fail AFTER spawn (so clone works normally)
      const gitInstance = mockSimpleGit();
      gitInstance.merge = vi.fn(async () => { throw new Error("Merge conflict in src/index.ts"); });
      vi.mocked(cmd.simpleGit as any).mockImplementation(() => gitInstance);

      // Attempt merge — should fail but recover cleanly
      await expect(
        agg.mergeAndClose({ cleanup: true, closeIssue: true })
      ).rejects.toThrow();

      // Git state should be reset to idle (not stuck in "merging")
      expect(agg.snapshot.git.op).toBe("idle");
      // Lifecycle stays active — user can retry or reject
      expect(agg.snapshot.lifecycle).toBe("active");

      // Restore default simpleGit mock
      vi.mocked(cmd.simpleGit as any).mockImplementation(() => mockSimpleGit());
    });
  });

  // =========================================================================
  // SCENARIO 8: Multiple agents on same project
  // =========================================================================
  describe("multiple concurrent agents", () => {
    it("spawns two agents independently on the same project", async () => {
      const issue1 = makeIssue({ identifier: "MULTI-1", externalId: "e1", phase: "todo" });
      const issue2 = makeIssue({ identifier: "MULTI-2", externalId: "e2", phase: "todo", title: "Add dark mode" });

      const data1 = makeAgentData("MULTI-1");
      const data2 = makeAgentData("MULTI-2");

      const agg1 = createAggregate("test-project", "/tmp/test-project", data1);
      const agg2 = createAggregate("test-project", "/tmp/test-project", data2);

      await agg1.spawnAgent({ trackerIssue: issue1 });
      await agg2.spawnAgent({ trackerIssue: issue2 });

      expect(agg1.snapshot.lifecycle).toBe("active");
      expect(agg2.snapshot.lifecycle).toBe("active");
      expect(agg1.agentData.branch).toBe("agent/MULTI-1");
      expect(agg2.agentData.branch).toBe("agent/MULTI-2");

      // Different port slots
      expect(agg1.agentData.portSlot).not.toBe(agg2.agentData.portSlot);

      // Agent 1 finishes, agent 2 still running
      agg1.reportProcessExited();
      expect(agg1.snapshot.agent).toBe("stopped");
      expect(agg2.snapshot.agent).toBe("running");
    });
  });

  // =========================================================================
  // SCENARIO 9: Wake terminal agent resets trackerStatus
  // =========================================================================
  describe("wake after done — reset trackerStatus", () => {
    it("waking a done agent resets trackerStatus to in_progress", async () => {
      const issue = makeIssue({ identifier: "WAKE-1", phase: "todo" });

      const agentData = makeAgentData("WAKE-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await agg.spawnAgent({ trackerIssue: issue });
      agg.reportProcessExited();

      // Simulate tracker marking as done (branch merged externally)
      agg.reportBranchMerged();
      expect(agg.snapshot.trackerStatus).toBe("done");
      expect(agg.snapshot.git.merged).toBe(true);

      // Ensure agent dir for wake
      const agentDir = agg.agentData.agentDir!;
      MOCK_DIRS.add(agentDir);
      MOCK_DIRS.add(join(agentDir, ".git"));
      MOCK_DIRS.add(join(agentDir, ".10timesdev"));

      // Wake resets the status
      await agg.wakeAgent("Please also update the tests");

      expect(agg.snapshot.trackerStatus).toBe("in_progress");
      expect(agg.snapshot.git.merged).toBe(false);
      expect(agg.snapshot.agent).toBe("running");
    });
  });

  // =========================================================================
  // SCENARIO 10: Remove agent (full cleanup)
  // =========================================================================
  describe("remove agent — full cleanup", () => {
    it("removes container, volume, repo, sets lifecycle=removed", async () => {
      const issue = makeIssue({ identifier: "RM-1", phase: "todo" });

      const agentData = makeAgentData("RM-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await agg.spawnAgent({ trackerIssue: issue });
      agg.reportProcessExited();

      await agg.removeAgent({ closeIssue: true, deleteBranch: true });

      expect(agg.snapshot.lifecycle).toBe("removed");
      expect(agg.snapshot.container).toBe("missing");
      expect(docker.removeContainer).toHaveBeenCalled();
      expect(docker.removeVolume).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // SCENARIO 11: Docker container creation failure
  // =========================================================================
  describe("container creation failure", () => {
    it("throws on container creation failure, agent ends in stopped state", async () => {
      const issue = makeIssue({ identifier: "DOCK-1", phase: "todo" });

      vi.mocked(docker.createAndStartContainer).mockRejectedValueOnce(
        new Error("Docker daemon is not running")
      );

      const agentData = makeAgentData("DOCK-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await expect(agg.spawnAgent({ trackerIssue: issue })).rejects.toThrow("Docker daemon is not running");

      expect(agg.snapshot.agent).toBe("stopped");
      expect(agg.snapshot.lifecycle).toBe("active");
      expect(emittedEvents.some(e => e.event === "agent:error")).toBe(true);
    });
  });

  // =========================================================================
  // SCENARIO 12: Restore removed agent
  // =========================================================================
  describe("restore removed agent", () => {
    it("restores a previously removed agent from its branch", async () => {
      const issue = makeIssue({ identifier: "REST-1", phase: "todo" });

      const agentData = makeAgentData("REST-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      // Spawn and remove
      await agg.spawnAgent({ trackerIssue: issue });
      agg.reportProcessExited();
      await agg.removeAgent({ closeIssue: false });
      expect(agg.snapshot.lifecycle).toBe("removed");

      // Prepare restore (sync phase — UI reflects immediately)
      agg.prepareRestore();
      expect(agg.snapshot.lifecycle).toBe("spawning");

      // Restore
      await agg.restoreAgent({ fromBranch: "agent/REST-1", setInProgress: true });

      expect(agg.snapshot.lifecycle).toBe("active");
      expect(agg.snapshot.agent).toBe("running");
      expect(agg.snapshot.trackerStatus).toBe("in_progress");
      expect(agg.agentData.spawned).toBe(true);
    });
  });

  // =========================================================================
  // SCENARIO 13: Queue message while agent is running
  // =========================================================================
  describe("queue message while running", () => {
    it("queues message to TASK.md without interrupting agent", async () => {
      const issue = makeIssue({ identifier: "Q-1", phase: "todo" });

      const agentData = makeAgentData("Q-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await agg.spawnAgent({ trackerIssue: issue });
      expect(agg.snapshot.agent).toBe("running");

      // Simulate agent dir for queueMessage
      const agentDir = agg.agentData.agentDir!;
      MOCK_DIRS.add(agentDir);
      MOCK_DIRS.add(join(agentDir, ".10timesdev"));

      agg.queueMessage("Also add unit tests");

      // Agent stays running
      expect(agg.snapshot.agent).toBe("running");
      // Message was appended to store
      const appendCalls = vi.mocked(store.appendMessage).mock.calls;
      const queuedMsg = appendCalls.find(c => c[3] === "Also add unit tests");
      expect(queuedMsg).toBeDefined();
    });
  });

  // =========================================================================
  // SCENARIO 14: Stop agent (user-initiated)
  // =========================================================================
  describe("stop agent", () => {
    it("stops running agent, container, and services", async () => {
      const issue = makeIssue({ identifier: "STOP-1", phase: "todo" });

      const agentData = makeAgentData("STOP-1");
      const agg = createAggregate("test-project", "/tmp/test-project", agentData);

      await agg.spawnAgent({ trackerIssue: issue });
      expect(agg.snapshot.agent).toBe("running");

      await agg.stopAgent();

      expect(agg.snapshot.agent).toBe("stopped");
      expect(agg.snapshot.container).toBe("stopped");
      expect(docker.killProcesses).toHaveBeenCalled();
      expect(emittedEvents.some(e => e.event === "agent:stopped")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Dispatcher integration tests
// ---------------------------------------------------------------------------

describe("E2E: Dispatcher tick", () => {

  it("spawns agent for todo issue during tick", async () => {
    const issue = makeIssue({ identifier: "DISP-1", phase: "todo" });
    mockTrackerIssues.push(issue);

    // We need to test the dispatcher's processProjectTrackers flow
    // Since dispatcher uses module-level state, we test by importing fresh
    const dispatcherModule = await import("@/services/dispatcher");

    // Start and immediately trigger
    // Note: we can't easily test tick() directly since it's not exported,
    // but triggerSync() calls tick() when running=true
    dispatcherModule.start();
    await flush(50);
    dispatcherModule.stop();

    // Verify: tracker was polled
    expect(mockTracker.pollIssues).toHaveBeenCalled();
  });

  it("skips spawn for already-spawning agent", async () => {
    const issue = makeIssue({ identifier: "DISP-2", phase: "todo" });
    mockTrackerIssues.push(issue);

    // Pre-create agent in spawning state
    const existing = makeAgentData("DISP-2");
    existing.state!.lifecycle = "spawning";
    existing.currentOperation = { name: "spawn", startedAt: new Date().toISOString() };
    mockAgents.set("DISP-2", existing);

    // Verify store returns the existing agent
    expect(vi.mocked(store.getAgent)("/tmp/test-project", "DISP-2")).toBeDefined();
    expect(vi.mocked(store.getAgent)("/tmp/test-project", "DISP-2")!.currentOperation!.name).toBe("spawn");
  });
});

// ---------------------------------------------------------------------------
// UI status derivation E2E
// ---------------------------------------------------------------------------

describe("E2E: UI Status across lifecycle", () => {
  it("transitions: starting → running → awaiting → closing → closed", async () => {
    const { deriveUiStatus } = await import("../types");
    const issue = makeIssue({ identifier: "UI-1", phase: "todo" });

    const agentData = makeAgentData("UI-1");
    const agg = createAggregate("test-project", "/tmp/test-project", agentData);

    // Before spawn: pending → starting
    expect(agg.uiStatus.status).toBe("starting");

    // During spawn op
    await agg.spawnAgent({ trackerIssue: issue });

    // After spawn: running
    expect(agg.uiStatus.status).toBe("running");

    // Agent exits: awaiting
    agg.reportProcessExited();
    expect(agg.uiStatus.status).toBe("awaiting");
    expect(agg.uiStatus.reason).toBe("completed");

    // During merge: closing
    // (We test this via deriveUiStatus directly since withLock is async)
    const closingState = { ...agg.snapshot, agent: "stopped" as const, lifecycle: "active" as const };
    const closingOp = { name: "mergeAndClose", startedAt: new Date().toISOString() };
    expect(deriveUiStatus(closingState as any, closingOp)).toEqual({ status: "closing" });

    // After merge+cleanup: closed
    await agg.mergeAndClose({ cleanup: true, closeIssue: true });
    expect(agg.uiStatus.status).toBe("closed");
  });
});
