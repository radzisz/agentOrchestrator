// ---------------------------------------------------------------------------
// Tests for ConversationAggregate
//
// Real filesystem — temp project + agent directory.
// Mocked AI — simulated agent responses (done, error, crash, etc.).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ConversationAggregate,
  buildTaskMd,
  buildClaudeMd,
  buildRulesMd,
  rewriteApiUrlsToLocal,
} from "../operations/conversation";
import type { ConversationDeps, ChatMessage, TaskContext } from "../operations/conversation";
import type { AIRule, PortInfo } from "@/lib/store";
import type { TrackerIssue } from "@/lib/issue-trackers/types";

// ---------------------------------------------------------------------------
// Real store on disk — minimal implementation for tests
// ---------------------------------------------------------------------------

function createDiskStore(projectPath: string) {
  function messagesPath(issueId: string): string {
    return join(projectPath, ".10timesdev", "agents", issueId, ".10timesdev", "messages.jsonl");
  }

  function ensureDir(p: string): void {
    const dir = p.substring(0, p.lastIndexOf("/")) || p.substring(0, p.lastIndexOf("\\"));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  return {
    getMessages(pp: string, issueId: string): ChatMessage[] {
      const fp = messagesPath(issueId);
      if (!existsSync(fp)) return [];
      return readFileSync(fp, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as ChatMessage; }
          catch { return null; }
        })
        .filter((m): m is ChatMessage => m !== null);
    },

    appendMessage(pp: string, issueId: string, role: "human" | "agent", text: string): void {
      const fp = messagesPath(issueId);
      ensureDir(fp);
      const msg: ChatMessage = { role, text, ts: new Date().toISOString() };
      appendFileSync(fp, JSON.stringify(msg) + "\n", "utf-8");
    },

    deleteMessage(pp: string, issueId: string, index: number): void {
      const msgs = this.getMessages(pp, issueId);
      if (index < 0 || index >= msgs.length) return;
      msgs.splice(index, 1);
      const fp = messagesPath(issueId);
      writeFileSync(fp, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testRoot: string;
let testProjectPath: string;
let testAgentDir: string;

function setupTestProject(issueId = "TEST-1"): void {
  testRoot = join(tmpdir(), `conv-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  testProjectPath = join(testRoot, "myproject");
  testAgentDir = join(testProjectPath, ".10timesdev", "agents", issueId, "git");
  mkdirSync(join(testAgentDir, ".10timesdev"), { recursive: true });
  // Create pnpm-lock.yaml so buildClaudeMd detects pnpm
  writeFileSync(join(testAgentDir, "pnpm-lock.yaml"), "", "utf-8");
}

function cleanupTestProject(): void {
  if (testRoot && existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function makePorts(slot = 10): PortInfo {
  const base = 40000 + slot * 6;
  return {
    slot,
    frontend: [base, base + 1, base + 2],
    backend: [base + 3, base + 4, base + 5],
  };
}

function makeCtx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    issueId: "TEST-1",
    projectName: "myproject",
    projectPath: testProjectPath,
    agentDir: testAgentDir,
    title: "Fix login bug",
    description: "Users cannot log in when password contains special chars",
    defaultBranch: "main",
    ports: makePorts(),
    ...overrides,
  };
}

function makeTrackerIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId: "uuid-123",
    identifier: "TEST-1",
    title: "Fix login bug",
    description: "Users cannot log in when password contains special chars",
    priority: 2,
    labels: ["bug", "auth"],
    rawState: "In Progress",
    source: "linear",
    createdAt: "2026-03-01T10:00:00Z",
    ...overrides,
  };
}

function makeRule(overrides: Partial<AIRule> = {}): AIRule {
  return {
    id: "rule_1",
    title: "Test Rule",
    content: "Do something",
    enabled: true,
    order: 0,
    whenToUse: "Always",
    ...overrides,
  };
}

function makeDeps(opts?: {
  globalRules?: AIRule[];
  projectRules?: AIRule[];
}): ConversationDeps {
  const diskStore = createDiskStore(testProjectPath);
  return {
    getMessages: (pp, id) => diskStore.getMessages(pp, id),
    appendMessage: (pp, id, role, text) => diskStore.appendMessage(pp, id, role, text),
    deleteMessage: (pp, id, index) => diskStore.deleteMessage(pp, id, index),
    getAIRules: () => opts?.globalRules || [],
    getProjectConfig: () =>
      opts?.projectRules
        ? { AI_RULES: JSON.stringify(opts.projectRules) }
        : {},
  };
}

/** Read a file from the agent's .10timesdev directory. */
function readAgentFile(filename: string): string {
  const p = join(testAgentDir, ".10timesdev", filename);
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

/** Simulate filtered agent output (what filterOutput returns). */
function simulateAgentDone(description: string): string {
  return `## Summary\n\n${description}\n\n\`\`\`json\n{"status":"done","description":"${description}"}\n\`\`\``;
}

function simulateAgentError(description: string): string {
  return `\`\`\`json\n{"status":"error","description":"${description}"}\n\`\`\``;
}

function simulateAgentNeedInfo(description: string): string {
  return `\`\`\`json\n{"status":"more_information_required","description":"${description}"}\n\`\`\``;
}

function simulateAgentCrash(): string {
  return "Segmentation fault (core dumped)\n[exit code 139]";
}

function simulateAgentOOM(): string {
  return "";
}

function simulateAgentGarbled(): string {
  return "Reading TASK.md...\nInstalling dep\x00\x01\x02endencies...\nKILLED";
}

// ---------------------------------------------------------------------------
// 1. Pure builders — no filesystem needed
// ---------------------------------------------------------------------------

describe("buildTaskMd", () => {
  beforeEach(() => setupTestProject());
  afterEach(() => cleanupTestProject());

  it("renders title and description", () => {
    const md = buildTaskMd(makeCtx(), []);
    expect(md).toContain("# TEST-1: Fix login bug");
    expect(md).toContain("## Opis");
    expect(md).toContain("Users cannot log in");
  });

  it("includes tracker metadata when issue provided", () => {
    const md = buildTaskMd(makeCtx({ trackerIssue: makeTrackerIssue() }), []);
    expect(md).toContain("## Priorytet\n2");
    expect(md).toContain("## Labelki\nbug, auth");
    expect(md).toContain("## Status\nIn Progress");
    expect(md).toContain("## Source\nlinear");
  });

  it("skips first message in conversation history", () => {
    const messages: ChatMessage[] = [
      { role: "human", text: "Initial task", ts: "t0" },
    ];
    const md = buildTaskMd(makeCtx(), messages);
    expect(md).not.toContain("Conversation history");
  });

  it("includes full dialogue after first message", () => {
    const messages: ChatMessage[] = [
      { role: "human", text: "Initial", ts: "t0" },
      { role: "agent", text: "Done round 1", ts: "t1" },
      { role: "human", text: "Now add tests", ts: "t2" },
      { role: "agent", text: "Tests added", ts: "t3" },
    ];
    const md = buildTaskMd(makeCtx(), messages);
    expect(md).toContain("## Conversation history");
    expect((md.match(/### Agent/g) || []).length).toBe(2);
    expect((md.match(/### Human/g) || []).length).toBe(1); // skip first human
    expect(md).toContain("Done round 1");
    expect(md).toContain("Now add tests");
    expect(md).toContain("Tests added");
  });
});

describe("buildClaudeMd", () => {
  beforeEach(() => setupTestProject());
  afterEach(() => cleanupTestProject());

  it("includes identity and ports", () => {
    const md = buildClaudeMd(makeCtx(), false);
    expect(md).toContain("Issue: **TEST-1**");
    expect(md).toContain("| Dev server | 40060 |");
  });

  it("detects pnpm from lockfile", () => {
    const md = buildClaudeMd(makeCtx(), false);
    expect(md).toContain("pnpm run build");
  });

  it("references conversation history in TASK.md", () => {
    const md = buildClaudeMd(makeCtx(), false);
    expect(md).toContain("task and conversation history");
  });

  it("includes rules section conditionally", () => {
    expect(buildClaudeMd(makeCtx(), true)).toContain("## AI Rules");
    expect(buildClaudeMd(makeCtx(), false)).not.toContain("## AI Rules");
  });

  it("includes all three JSON response formats", () => {
    const md = buildClaudeMd(makeCtx(), false);
    expect(md).toContain('"status": "done"');
    expect(md).toContain('"status": "more_information_required"');
    expect(md).toContain('"status": "error"');
  });
});

// ---------------------------------------------------------------------------
// API URL → local path rewriting
// ---------------------------------------------------------------------------

describe("rewriteApiUrlsToLocal", () => {
  it("rewrites agent image API URLs", () => {
    const text = "![screenshot](/api/projects/myproject/agents/TEST-1/images/img-1.png)";
    expect(rewriteApiUrlsToLocal(text)).toBe("![screenshot](.10timesdev/images/img-1.png)");
  });

  it("rewrites task image API URLs", () => {
    const text = "![pic](/api/projects/myproject/tasks/images/img-86df.png)";
    expect(rewriteApiUrlsToLocal(text)).toBe("![pic](.10timesdev/images/img-86df.png)");
  });

  it("rewrites multiple URLs in one text", () => {
    const text = "A ![a](/api/projects/p/agents/X/images/img-1.png) B ![b](/api/projects/p/tasks/images/img-2.jpg)";
    const result = rewriteApiUrlsToLocal(text);
    expect(result).toContain(".10timesdev/images/img-1.png");
    expect(result).toContain(".10timesdev/images/img-2.jpg");
    expect(result).not.toContain("/api/projects/");
  });

  it("leaves non-API URLs unchanged", () => {
    expect(rewriteApiUrlsToLocal("![pic](https://example.com/img.png)"))
      .toBe("![pic](https://example.com/img.png)");
  });

  it("leaves already-local paths unchanged", () => {
    expect(rewriteApiUrlsToLocal("![pic](.10timesdev/images/img-1.png)"))
      .toBe("![pic](.10timesdev/images/img-1.png)");
  });

  it("handles empty text", () => {
    expect(rewriteApiUrlsToLocal("")).toBe("");
  });

  it("handles plain text without images", () => {
    expect(rewriteApiUrlsToLocal("no images here")).toBe("no images here");
  });
});

describe("buildTaskMd with attachments", () => {
  beforeEach(() => setupTestProject());
  afterEach(() => cleanupTestProject());

  function createImage(filename: string): void {
    const dir = join(testAgentDir, ".10timesdev", "images");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), "fake");
  }

  it("lists downloaded attachments", () => {
    createImage("img-1.png");
    createImage("screenshot.pdf");
    const md = buildTaskMd(makeCtx(), []);
    expect(md).toContain("## Załączniki");
    expect(md).toContain("`.10timesdev/images/img-1.png`");
    expect(md).toContain("`.10timesdev/images/screenshot.pdf`");
  });

  it("no attachments section when images dir is empty", () => {
    const md = buildTaskMd(makeCtx(), []);
    expect(md).not.toContain("Załączniki");
  });

  it("rewrites API URLs in conversation messages", () => {
    const messages: ChatMessage[] = [
      { role: "human", text: "task", ts: "t0" },
      { role: "human", text: "See ![pic](/api/projects/p/agents/X/images/img-2.jpg)", ts: "t1" },
    ];
    const md = buildTaskMd(makeCtx(), messages);
    expect(md).toContain(".10timesdev/images/img-2.jpg");
    expect(md).not.toContain("/api/projects/");
  });
});

describe("buildRulesMd", () => {
  it("returns empty for no rules", () => {
    expect(buildRulesMd([])).toBe("");
  });

  it("renders rules with whenToUse and separators", () => {
    const md = buildRulesMd([
      makeRule({ title: "Rule A", order: 0 }),
      makeRule({ id: "r2", title: "Rule B", order: 1, whenToUse: undefined }),
    ]);
    expect(md).toContain("### 1. Rule A");
    expect(md).toContain("**When to use:** Always");
    expect(md).toContain("### 2. Rule B");
    expect(md).toContain("---");
  });
});

// ---------------------------------------------------------------------------
// 2. ConversationAggregate — real filesystem, mocked AI
// ---------------------------------------------------------------------------

describe("ConversationAggregate", () => {
  beforeEach(() => setupTestProject());
  afterEach(() => cleanupTestProject());

  // -----------------------------------------------------------------------
  // Message management — verified on disk
  // -----------------------------------------------------------------------

  describe("messages on disk", () => {
    it("addHumanMessage persists to messages.jsonl", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.addHumanMessage("Fix the bug");

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ role: "human", text: "Fix the bug" });
    });

    it("addAgentResponse persists to messages.jsonl", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.addAgentResponse("Done.");

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ role: "agent", text: "Done." });
    });

    it("ignores blank messages", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.addHumanMessage("");
      conv.addHumanMessage("   ");
      conv.addAgentResponse("");
      expect(conv.getMessages()).toHaveLength(0);
    });

    it("deleteMessage removes from disk and returns remaining", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.addHumanMessage("msg1");
      conv.addAgentResponse("msg2");
      conv.addHumanMessage("msg3");

      const remaining = conv.deleteMessage(1); // delete agent msg
      expect(remaining).toHaveLength(2);
      expect(remaining[0].text).toBe("msg1");
      expect(remaining[1].text).toBe("msg3");

      // Verify disk
      const diskMsgs = conv.getMessages();
      expect(diskMsgs).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // recordAgentExit — various AI responses
  // -----------------------------------------------------------------------

  describe("recordAgentExit", () => {
    it("records done response", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.recordAgentExit(simulateAgentDone("Fixed the login"));
      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("agent");
      expect(msgs[0].text).toContain("Fixed the login");
    });

    it("records error response", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.recordAgentExit(simulateAgentError("Build failed"));
      expect(conv.getMessages()[0].text).toContain("Build failed");
    });

    it("records more_information_required", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.recordAgentExit(simulateAgentNeedInfo("Need API key"));
      expect(conv.getMessages()[0].text).toContain("Need API key");
    });

    it("records crash output", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.recordAgentExit(simulateAgentCrash());
      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].text).toContain("Segmentation fault");
    });

    it("ignores OOM / empty output", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.recordAgentExit(simulateAgentOOM());
      expect(conv.getMessages()).toHaveLength(0);
    });

    it("records garbled output as-is", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.recordAgentExit(simulateAgentGarbled());
      expect(conv.getMessages()).toHaveLength(1);
      expect(conv.getMessages()[0].text).toContain("KILLED");
    });

    it("truncates output longer than 50 lines", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
      conv.recordAgentExit(lines.join("\n"));
      const recorded = conv.getMessages()[0].text;
      expect(recorded.split("\n")).toHaveLength(50);
      expect(recorded).toContain("line-99");
      expect(recorded).toContain("line-50");
      expect(recorded).not.toContain("line-49");
    });
  });

  // -----------------------------------------------------------------------
  // File rebuilding — TASK.md, CLAUDE.md, RULES.md on disk
  // -----------------------------------------------------------------------

  describe("file rebuilding", () => {
    it("rebuildTaskMd writes file to agent dir", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.rebuildTaskMd();

      const content = readAgentFile("TASK.md");
      expect(content).toContain("# TEST-1: Fix login bug");
    });

    it("rebuildTaskMd overwrites — never appends", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      // First build
      conv.addHumanMessage("task A");
      conv.rebuildTaskMd();

      // Second build after more messages
      conv.addAgentResponse("done A");
      conv.addHumanMessage("task B");
      conv.rebuildTaskMd();

      const content = readAgentFile("TASK.md");
      // "Conversation history" section should appear exactly once
      expect((content.match(/## Conversation history/g) || []).length).toBe(1);
    });

    it("rebuildClaudeMd writes correct file", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.rebuildClaudeMd(false);
      expect(readAgentFile("CLAUDE.md")).toContain("Agent TEST-1");
    });

    it("rebuildRulesMd writes when rules exist", () => {
      const deps = makeDeps({ globalRules: [makeRule({ title: "Max 800 lines" })] });
      const conv = new ConversationAggregate(makeCtx(), deps);
      expect(conv.rebuildRulesMd()).toBe(true);
      expect(readAgentFile("RULES.md")).toContain("Max 800 lines");
    });

    it("rebuildRulesMd returns false when no rules", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      expect(conv.rebuildRulesMd()).toBe(false);
    });

    it("rebuildRulesMd filters disabled, sorts by order", () => {
      const deps = makeDeps({
        globalRules: [
          makeRule({ id: "g1", title: "Global B", order: 2 }),
          makeRule({ id: "g2", title: "Global A", order: 0 }),
          makeRule({ id: "g3", title: "Disabled", enabled: false, order: 1 }),
        ],
        projectRules: [
          makeRule({ id: "p1", title: "Project C", order: 1 }),
        ],
      });
      const conv = new ConversationAggregate(makeCtx(), deps);
      conv.rebuildRulesMd();

      const content = readAgentFile("RULES.md");
      expect(content).not.toContain("Disabled");
      const posA = content.indexOf("Global A");
      const posC = content.indexOf("Project C");
      const posB = content.indexOf("Global B");
      expect(posA).toBeLessThan(posC);
      expect(posC).toBeLessThan(posB);
    });
  });

  // -----------------------------------------------------------------------
  // prepareForLaunch — full orchestration
  // -----------------------------------------------------------------------

  describe("prepareForLaunch", () => {
    it("first launch — writes all files, returns initial prompt", () => {
      const deps = makeDeps({ globalRules: [makeRule()] });
      const conv = new ConversationAggregate(makeCtx(), deps);
      conv.addHumanMessage("Fix the bug");

      const prompt = conv.prepareForLaunch();

      // Files on disk
      expect(readAgentFile("TASK.md")).toContain("# TEST-1");
      expect(readAgentFile("CLAUDE.md")).toContain("Agent TEST-1");
      expect(readAgentFile("RULES.md")).toContain("Test Rule");

      // Initial prompt
      expect(prompt).toContain("this is your task");
      expect(prompt).not.toContain("NEW INSTRUCTIONS");
    });

    it("wake with message — records and rebuilds", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      // Spawn
      conv.addHumanMessage("initial task");
      conv.prepareForLaunch();
      conv.recordAgentExit(simulateAgentDone("did the thing"));

      // Wake
      const prompt = conv.prepareForLaunch({ newMessage: "now fix tests" });

      expect(prompt).toContain("NEW INSTRUCTIONS");

      const task = readAgentFile("TASK.md");
      expect(task).toContain("did the thing");
      expect(task).toContain("now fix tests");
    });

    it("wake without message — continue prompt", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.addHumanMessage("task");
      conv.prepareForLaunch();
      conv.recordAgentExit("partial work");

      const prompt = conv.prepareForLaunch();
      expect(prompt).toContain("Continue working");
    });

    it("CLAUDE.md gets rules section when rules exist", () => {
      const deps = makeDeps({ globalRules: [makeRule()] });
      const conv = new ConversationAggregate(makeCtx(), deps);
      conv.addHumanMessage("task");
      conv.prepareForLaunch();
      expect(readAgentFile("CLAUDE.md")).toContain("## AI Rules");
    });

    it("CLAUDE.md has no rules section when none configured", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.addHumanMessage("task");
      conv.prepareForLaunch();
      expect(readAgentFile("CLAUDE.md")).not.toContain("## AI Rules");
    });
  });

  // -----------------------------------------------------------------------
  // Full lifecycle scenarios — simulated AI
  // -----------------------------------------------------------------------

  describe("lifecycle: spawn → done → wake → done", () => {
    it("full two-round conversation", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      // Round 1: spawn
      conv.addHumanMessage("Fix login with special chars");
      const p1 = conv.prepareForLaunch();
      expect(p1).toContain("this is your task");
      conv.recordAgentExit(simulateAgentDone("Fixed password encoding"));

      // Round 2: wake
      const p2 = conv.prepareForLaunch({ newMessage: "Also fix logout" });
      expect(p2).toContain("NEW INSTRUCTIONS");
      conv.recordAgentExit(simulateAgentDone("Fixed logout handler"));

      // Verify disk
      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(4);
      expect(msgs.map((m) => m.role)).toEqual(["human", "agent", "human", "agent"]);

      // TASK.md was rebuilt at prepareForLaunch (before 2nd agent run).
      // To see the 2nd agent response in TASK.md, rebuild once more.
      conv.prepareForLaunch();
      const task = readAgentFile("TASK.md");
      expect(task).toContain("Fixed password encoding");
      expect(task).toContain("Also fix logout");
      expect(task).toContain("Fixed logout handler");
    });
  });

  describe("lifecycle: agent crashes", () => {
    it("crash is recorded, next wake includes crash in history", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      conv.addHumanMessage("Refactor module");
      conv.prepareForLaunch();
      conv.recordAgentExit(simulateAgentCrash());

      // User wakes with instructions
      conv.prepareForLaunch({ newMessage: "Try again carefully" });

      const task = readAgentFile("TASK.md");
      expect(task).toContain("Segmentation fault");
      expect(task).toContain("Try again carefully");
    });
  });

  describe("lifecycle: agent needs more info", () => {
    it("agent asks for info, user provides, agent completes", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      conv.addHumanMessage("Deploy to prod");
      conv.prepareForLaunch();
      conv.recordAgentExit(simulateAgentNeedInfo("Need AWS_REGION"));

      conv.prepareForLaunch({ newMessage: "AWS_REGION=eu-central-1" });
      conv.recordAgentExit(simulateAgentDone("Deployed"));

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(4);

      // Rebuild to include last agent response
      conv.prepareForLaunch();
      const task = readAgentFile("TASK.md");
      expect(task).toContain("Need AWS_REGION");
      expect(task).toContain("AWS_REGION=eu-central-1");
      expect(task).toContain("Deployed");
    });
  });

  describe("lifecycle: agent returns error", () => {
    it("error recorded, user provides fix context", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      conv.addHumanMessage("Migrate database");
      conv.prepareForLaunch();
      conv.recordAgentExit(simulateAgentError("Connection refused"));

      conv.prepareForLaunch({ newMessage: "Use port 5433" });

      const task = readAgentFile("TASK.md");
      expect(task).toContain("Connection refused");
      expect(task).toContain("Use port 5433");
    });
  });

  describe("lifecycle: agent OOM (no output)", () => {
    it("empty output not recorded, next wake works", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      conv.addHumanMessage("Heavy task");
      conv.prepareForLaunch();
      conv.recordAgentExit(simulateAgentOOM());

      expect(conv.getMessages()).toHaveLength(1); // only human msg

      // User can still wake
      const prompt = conv.prepareForLaunch({ newMessage: "Try with smaller input" });
      expect(prompt).toContain("NEW INSTRUCTIONS");
      expect(conv.getMessages()).toHaveLength(2);
    });
  });

  describe("lifecycle: user deletes message", () => {
    it("deleted message disappears from TASK.md after rebuild", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      conv.addHumanMessage("initial");
      conv.prepareForLaunch();
      conv.recordAgentExit(simulateAgentDone("round 1"));
      conv.addHumanMessage("WRONG — delete this");

      // Delete the wrong message (index 2)
      conv.deleteMessage(2);
      conv.prepareForLaunch();

      const task = readAgentFile("TASK.md");
      expect(task).not.toContain("WRONG");
      expect(task).toContain("round 1");
    });
  });

  describe("lifecycle: garbled agent output", () => {
    it("garbled output is preserved in conversation", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      conv.addHumanMessage("task");
      conv.prepareForLaunch();
      conv.recordAgentExit(simulateAgentGarbled());

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(2);
      expect(msgs[1].text).toContain("KILLED");

      // User can still continue
      conv.prepareForLaunch({ newMessage: "Something went wrong, try again" });
      const task = readAgentFile("TASK.md");
      expect(task).toContain("KILLED");
      expect(task).toContain("try again");
    });
  });

  describe("lifecycle: many rounds", () => {
    it("5 rounds — all messages in disk + TASK.md consistent", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      for (let i = 1; i <= 5; i++) {
        if (i === 1) {
          conv.addHumanMessage(`task round ${i}`);
          conv.prepareForLaunch();
        } else {
          conv.prepareForLaunch({ newMessage: `task round ${i}` });
        }
        conv.recordAgentExit(simulateAgentDone(`done round ${i}`));
      }

      // 5 human + 5 agent = 10 messages
      expect(conv.getMessages()).toHaveLength(10);

      // Rebuild to include last agent response in TASK.md
      conv.prepareForLaunch();
      const task = readAgentFile("TASK.md");
      for (let i = 1; i <= 5; i++) {
        expect(task).toContain(`done round ${i}`);
      }
      // First human message is title, remaining 4 in conversation
      expect((task.match(/### Human/g) || []).length).toBe(4);
      expect((task.match(/### Agent/g) || []).length).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("special characters in messages survive round-trip", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      const msg = 'Fix regex /[a-z]+\\d{3}/g and path C:\\Users\\test and "quotes"';
      conv.addHumanMessage("initial task");
      conv.prepareForLaunch();
      conv.recordAgentExit("done");

      // Second message with special chars — shows up in conversation history
      conv.prepareForLaunch({ newMessage: msg });

      const task = readAgentFile("TASK.md");
      expect(task).toContain("/[a-z]+\\d{3}/g");
      expect(task).toContain("C:\\Users\\test");

      // messages.jsonl preserves exact text
      const msgs = conv.getMessages();
      expect(msgs[2].text).toBe(msg);
    });

    it("agent markdown in response doesn't break TASK.md structure", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      conv.addHumanMessage("task");
      conv.prepareForLaunch();
      conv.recordAgentExit("## Agent's heading\n\n### Subheading\n\n- bullet");

      conv.prepareForLaunch();
      const task = readAgentFile("TASK.md");

      // The conversation section still has proper structure
      expect(task).toContain("### Agent\n\n## Agent's heading");
      expect(task).toContain("- bullet");
    });

    it("no tracker issue — minimal TASK.md", () => {
      const ctx = makeCtx({ trackerIssue: undefined, description: undefined });
      const conv = new ConversationAggregate(ctx, makeDeps());
      conv.rebuildTaskMd();

      const task = readAgentFile("TASK.md");
      expect(task).toContain("# TEST-1");
      expect(task).not.toContain("Priorytet");
      expect(task).not.toContain("Labelki");
    });

    it("TASK.md is fully rebuilt (not appended) on each prepareForLaunch", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());

      // Round 1
      conv.addHumanMessage("task");
      conv.prepareForLaunch();
      conv.recordAgentExit("done");

      // Round 2
      conv.prepareForLaunch({ newMessage: "more" });
      conv.recordAgentExit("done again");

      // Round 3 — rebuild
      conv.prepareForLaunch();

      const task = readAgentFile("TASK.md");
      // Title should appear exactly once
      expect((task.match(/# TEST-1: Fix login bug/g) || []).length).toBe(1);
      // Conversation history section exactly once
      expect((task.match(/## Conversation history/g) || []).length).toBe(1);
    });
  });
});
