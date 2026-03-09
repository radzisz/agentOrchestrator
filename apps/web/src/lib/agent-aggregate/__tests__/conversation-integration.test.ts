// ---------------------------------------------------------------------------
// Integration tests for ConversationAggregate
//
// Full lifecycle tests: prepareForLaunch → agent response → recordAgentExit
// Real filesystem, simulated agent responses (no Docker, no git, no AI).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync, copyFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ConversationAggregate,
  buildTaskMd,
  rewriteApiUrlsToLocal,
} from "../operations/conversation";
import type { ConversationDeps, ChatMessage, TaskContext } from "../operations/conversation";
import type { AIRule, PortInfo } from "@/lib/store";
import type { TrackerIssue } from "@/lib/issue-trackers/types";

// ---------------------------------------------------------------------------
// Disk store — same pattern as conversation.test.ts
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
// Setup / Teardown
// ---------------------------------------------------------------------------

let testRoot: string;
let testProjectPath: string;
let testAgentDir: string;

function setupTestProject(issueId = "INT-1"): void {
  testRoot = join(tmpdir(), `conv-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
    issueId: "INT-1",
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
    externalId: "uuid-int",
    identifier: "INT-1",
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

function readAgentFile(filename: string): string {
  const p = join(testAgentDir, ".10timesdev", filename);
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

/**
 * Simulate what spawnAgent() does: seed the initial human message in messages.jsonl.
 * The ConversationAggregate itself doesn't auto-create this — spawn.ts does.
 */
function seedInitialMessage(conv: ConversationAggregate, ctx: TaskContext): void {
  conv.addHumanMessage(`${ctx.issueId}: ${ctx.title}\n\n${ctx.description || ""}`);
}

// ---------------------------------------------------------------------------
// Simulated agent responses (what filterOutput returns)
// ---------------------------------------------------------------------------

function agentDone(desc: string): string {
  return `## Summary\n\n${desc}\n\n\`\`\`json\n{"status":"done","description":"${desc}"}\n\`\`\``;
}

function agentError(desc: string): string {
  return `Encountered an error:\n\n\`\`\`json\n{"status":"error","description":"${desc}"}\n\`\`\``;
}

function agentNeedInfo(desc: string): string {
  return `I need more details:\n\n\`\`\`json\n{"status":"more_information_required","description":"${desc}"}\n\`\`\``;
}

function agentCrash(): string {
  return "Segmentation fault (core dumped)\n[exit code 139]";
}

function agentOOM(): string {
  return "";
}

function agentGarbled(): string {
  return "Reading TASK.md...\nInstalling dep\x00\x01\x02endencies...\nKILLED";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationAggregate — integration lifecycle", () => {
  beforeEach(() => setupTestProject());
  afterEach(() => cleanupTestProject());

  // -------------------------------------------------------------------------
  // 1. Task with image attachments
  // -------------------------------------------------------------------------

  describe("task with image attachments", () => {
    it("lists images in TASK.md attachments section", () => {
      // Place test images in agent's .10timesdev/images/
      const imagesDir = join(testAgentDir, ".10timesdev", "images");
      mkdirSync(imagesDir, { recursive: true });
      writeFileSync(join(imagesDir, "img-1.png"), Buffer.from("fake-png"));
      writeFileSync(join(imagesDir, "screenshot.jpg"), Buffer.from("fake-jpg"));

      const ctx = makeCtx({
        description: "See the screenshot for the bug: ![bug](/api/projects/myproject/agents/INT-1/images/img-1.png)",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());

      const prompt = conv.prepareForLaunch();
      const taskMd = readAgentFile("TASK.md");

      // Attachments section lists the files
      expect(taskMd).toContain("## Załączniki");
      expect(taskMd).toContain("`.10timesdev/images/img-1.png`");
      expect(taskMd).toContain("`.10timesdev/images/screenshot.jpg`");

      // Prompt is initial (no conversation yet)
      expect(prompt).toContain("this is your task");
    });

    it("rewrites API image URLs in conversation history", () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      const conv = new ConversationAggregate(ctx, deps);
      seedInitialMessage(conv, ctx);

      // Initial launch
      conv.prepareForLaunch();
      conv.recordAgentExit(agentDone("Fixed the login form"));

      // Human sends message with API image URL
      const prompt = conv.prepareForLaunch({
        newMessage: "Look at this: ![err](/api/projects/myproject/agents/INT-1/images/img-2.png) — same bug?",
      });

      const taskMd = readAgentFile("TASK.md");
      // URL should be rewritten to local path
      expect(taskMd).toContain(".10timesdev/images/img-2.png");
      expect(taskMd).not.toContain("/api/projects/myproject/agents/INT-1/images/img-2.png");
      expect(prompt).toContain("NEW INSTRUCTIONS");
    });

    it("rewrites task image URLs in human messages from CDM", () => {
      const ctx = makeCtx();
      const deps = makeDeps();
      const conv = new ConversationAggregate(ctx, deps);
      seedInitialMessage(conv, ctx);

      conv.prepareForLaunch();
      conv.recordAgentExit(agentDone("Done"));

      conv.prepareForLaunch({
        newMessage: "See this screenshot: ![s](/api/projects/myproject/tasks/images/img-1.png)",
      });

      const taskMd = readAgentFile("TASK.md");
      expect(taskMd).toContain(".10timesdev/images/img-1.png");
    });

    it("handles PDF attachment referenced in description", () => {
      const imagesDir = join(testAgentDir, ".10timesdev", "images");
      mkdirSync(imagesDir, { recursive: true });
      writeFileSync(join(imagesDir, "spec.pdf"), Buffer.from("fake-pdf"));

      const ctx = makeCtx({
        description: "Implement the feature described in the attached PDF spec.",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());

      conv.prepareForLaunch();
      const taskMd = readAgentFile("TASK.md");

      expect(taskMd).toContain("## Załączniki");
      expect(taskMd).toContain("`.10timesdev/images/spec.pdf`");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Agent asks for more information → human provides → agent completes
  // -------------------------------------------------------------------------

  describe("more_information_required flow", () => {
    it("full cycle: spawn → need info → provide info → done", () => {
      const ctx = makeCtx({
        title: "Add dark mode toggle",
        description: "Add a dark mode toggle to the settings page",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      // Round 1: initial launch
      const prompt1 = conv.prepareForLaunch();
      expect(prompt1).toContain("this is your task");

      // Agent asks for details
      conv.recordAgentExit(agentNeedInfo(
        "Which color palette should I use for dark mode? Material Design or custom?"
      ));

      const msgs1 = conv.getMessages();
      expect(msgs1).toHaveLength(2); // initial task + agent response
      expect(msgs1[1].role).toBe("agent");
      expect(msgs1[1].text).toContain("more_information_required");

      // Round 2: human answers
      const prompt2 = conv.prepareForLaunch({
        newMessage: "Use Material Design dark palette. Primary: #BB86FC, Surface: #121212",
      });
      expect(prompt2).toContain("NEW INSTRUCTIONS");

      // TASK.md should contain the full conversation
      const taskMd2 = readAgentFile("TASK.md");
      expect(taskMd2).toContain("## Conversation history");
      expect(taskMd2).toContain("more_information_required");
      expect(taskMd2).toContain("Material Design dark palette");
      expect(taskMd2).toContain("#BB86FC");

      // Agent completes
      conv.recordAgentExit(agentDone("Implemented dark mode with Material Design palette"));

      const msgs2 = conv.getMessages();
      expect(msgs2).toHaveLength(4); // initial + agent-question + human-answer + agent-done
      expect(msgs2[3].role).toBe("agent");
      expect(msgs2[3].text).toContain("Implemented dark mode");

      // Round 3: verify TASK.md has all history after rebuild
      conv.prepareForLaunch();
      const taskMd3 = readAgentFile("TASK.md");
      expect(taskMd3).toContain("Implemented dark mode");
    });

    it("agent asks twice before completing", () => {
      const ctx = makeCtx({
        title: "Refactor API",
        description: "Refactor the REST API endpoints",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      // Launch
      conv.prepareForLaunch();

      // Agent asks first question
      conv.recordAgentExit(agentNeedInfo("Which endpoints should I refactor? All or just /users?"));

      // Human responds
      conv.prepareForLaunch({ newMessage: "Focus on /users and /orders endpoints" });

      // Agent asks second question
      conv.recordAgentExit(agentNeedInfo("Should I maintain backward compatibility or is breaking change OK?"));

      // Human responds again
      conv.prepareForLaunch({ newMessage: "Maintain backward compat, add v2 routes" });

      // Agent completes
      conv.recordAgentExit(agentDone("Refactored /users and /orders with v2 routes, backward compatible"));

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(6); // initial + q1 + a1 + q2 + a2 + done

      conv.prepareForLaunch();
      const taskMd = readAgentFile("TASK.md");
      expect(taskMd).toContain("/users and /orders");
      expect(taskMd).toContain("backward compat");
      expect(taskMd).toContain("v2 routes");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Error scenarios
  // -------------------------------------------------------------------------

  describe("error responses", () => {
    it("agent reports build error", () => {
      const ctx = makeCtx({
        title: "Add TypeScript strict mode",
        description: "Enable strict mode in tsconfig.json",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      conv.prepareForLaunch();
      conv.recordAgentExit(agentError(
        "Build failed with 47 type errors after enabling strict mode. " +
        "The codebase has too many implicit any types to fix in one pass."
      ));

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(2);
      expect(msgs[1].text).toContain("47 type errors");

      // Human provides guidance
      conv.prepareForLaunch({
        newMessage: "Enable strict incrementally: start with noImplicitAny only, fix those errors first",
      });

      const taskMd = readAgentFile("TASK.md");
      expect(taskMd).toContain("47 type errors");
      expect(taskMd).toContain("noImplicitAny only");

      // Agent succeeds this time
      conv.recordAgentExit(agentDone("Enabled noImplicitAny, fixed 12 errors"));
      expect(conv.getMessages()).toHaveLength(4);
    });

    it("agent crashes (segfault)", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      conv.prepareForLaunch();
      conv.recordAgentExit(agentCrash());

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(2);
      expect(msgs[1].text).toContain("Segmentation fault");

      // Retry — human says "try again"
      conv.prepareForLaunch({ newMessage: "Try again, the crash was transient" });

      const taskMd = readAgentFile("TASK.md");
      expect(taskMd).toContain("Segmentation fault");
      expect(taskMd).toContain("Try again");
    });

    it("agent OOM (empty output)", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      conv.prepareForLaunch();
      conv.recordAgentExit(agentOOM());

      // Empty output is not recorded
      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(1); // only initial task

      // Wake again
      conv.prepareForLaunch({ newMessage: "Retry with smaller scope" });

      const taskMd = readAgentFile("TASK.md");
      // No agent response in conversation (OOM = empty)
      expect(taskMd).toContain("Retry with smaller scope");
    });

    it("agent garbled output", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      conv.prepareForLaunch();
      conv.recordAgentExit(agentGarbled());

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(2);
      // Garbled text should still be stored (it's the agent's actual output)
      expect(msgs[1].text).toContain("KILLED");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multi-round conversation with mixed responses
  // -------------------------------------------------------------------------

  describe("multi-round lifecycle", () => {
    it("5 rounds: spawn → error → retry → need_info → answer → done", () => {
      const ctx = makeCtx({
        title: "Implement search feature",
        description: "Add full-text search to the products page",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      // Round 1: spawn
      conv.prepareForLaunch();
      expect(conv.getMessages()).toHaveLength(1);

      // Round 1 result: error
      conv.recordAgentExit(agentError("Cannot find products table — database schema unclear"));

      // Round 2: human provides DB info
      conv.prepareForLaunch({
        newMessage: "Products are in the `items` table. Schema: id, name, description, price",
      });

      // Round 2 result: agent needs more info
      conv.recordAgentExit(agentNeedInfo("Should search cover description field too or just name?"));

      // Round 3: human answers
      conv.prepareForLaunch({
        newMessage: "Search both name and description. Use pg_trgm for fuzzy matching.",
      });

      // Round 3 result: done
      conv.recordAgentExit(agentDone("Implemented full-text search on items table using pg_trgm"));

      // Verify final state
      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(6);
      expect(msgs[0].role).toBe("human"); // initial
      expect(msgs[1].role).toBe("agent");  // error
      expect(msgs[2].role).toBe("human"); // DB info
      expect(msgs[3].role).toBe("agent");  // need_info
      expect(msgs[4].role).toBe("human"); // answer
      expect(msgs[5].role).toBe("agent");  // done

      // Verify TASK.md contains full conversation
      conv.prepareForLaunch();
      const taskMd = readAgentFile("TASK.md");
      expect(taskMd).toContain("## Conversation history");
      expect(taskMd).toContain("Cannot find products table");
      expect(taskMd).toContain("`items` table");
      expect(taskMd).toContain("pg_trgm");
      expect(taskMd).toContain("Implemented full-text search");
    });

    it("conversation with images in multiple rounds", () => {
      const imagesDir = join(testAgentDir, ".10timesdev", "images");
      mkdirSync(imagesDir, { recursive: true });
      writeFileSync(join(imagesDir, "img-1.png"), Buffer.from("fake-png"));

      const ctx = makeCtx({
        title: "Fix UI alignment",
        description: "Button is misaligned. See ![bug](/api/projects/myproject/agents/INT-1/images/img-1.png)",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      // Round 1
      conv.prepareForLaunch();

      // Agent asks
      conv.recordAgentExit(agentNeedInfo("Is the misalignment in mobile view or desktop?"));

      // Round 2: human with another image reference
      writeFileSync(join(imagesDir, "img-2.png"), Buffer.from("fake-png-2"));
      conv.prepareForLaunch({
        newMessage: "Desktop view. Here's another screenshot: ![desktop](/api/projects/myproject/agents/INT-1/images/img-2.png)",
      });

      const taskMd = readAgentFile("TASK.md");
      // Both images listed in attachments
      expect(taskMd).toContain("`.10timesdev/images/img-1.png`");
      expect(taskMd).toContain("`.10timesdev/images/img-2.png`");
      // URL in conversation rewritten to local
      expect(taskMd).toContain(".10timesdev/images/img-2.png");
      expect(taskMd).not.toContain("/api/projects/myproject/agents/INT-1/images/img-2.png");
    });
  });

  // -------------------------------------------------------------------------
  // 5. File generation consistency
  // -------------------------------------------------------------------------

  describe("file generation", () => {
    it("CLAUDE.md is regenerated on each prepareForLaunch", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());

      conv.prepareForLaunch();
      const claude1 = readAgentFile("CLAUDE.md");
      expect(claude1).toContain("Agent INT-1");
      expect(claude1).toContain("pnpm run build");

      // Modify port to verify regeneration
      const ctx2 = makeCtx({ ports: makePorts(20) });
      const conv2 = new ConversationAggregate(ctx2, makeDeps());
      conv2.prepareForLaunch();
      const claude2 = readAgentFile("CLAUDE.md");
      expect(claude2).toContain("40120"); // slot 20 → base 40120
    });

    it("RULES.md generated only when rules exist", () => {
      const ctx = makeCtx();

      // No rules
      const conv1 = new ConversationAggregate(ctx, makeDeps());
      conv1.prepareForLaunch();
      expect(readAgentFile("RULES.md")).toBe("");
      expect(readAgentFile("CLAUDE.md")).not.toContain("## AI Rules");

      // With rules
      const conv2 = new ConversationAggregate(ctx, makeDeps({
        globalRules: [{
          id: "r1", title: "Use TypeScript", content: "Always use TypeScript",
          enabled: true, order: 0, whenToUse: "All TypeScript projects",
        }],
      }));
      conv2.prepareForLaunch();
      expect(readAgentFile("RULES.md")).toContain("Use TypeScript");
      expect(readAgentFile("CLAUDE.md")).toContain("## AI Rules");
    });

    it("TASK.md is fully overwritten (not appended) on each launch", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      // Round 1
      conv.prepareForLaunch();
      conv.recordAgentExit(agentDone("Fixed round 1"));

      // Round 2
      conv.prepareForLaunch({ newMessage: "Now add tests" });
      conv.recordAgentExit(agentDone("Added tests"));

      // Round 3
      conv.prepareForLaunch({ newMessage: "Run the tests" });

      const taskMd = readAgentFile("TASK.md");
      // Should have exactly one title (not duplicated by append)
      const titleMatches = taskMd.match(/# INT-1: Fix login bug/g);
      expect(titleMatches).toHaveLength(1);
      // Should have conversation history section
      expect(taskMd).toContain("## Conversation history");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Prompt selection
  // -------------------------------------------------------------------------

  describe("prompt selection", () => {
    it("first launch returns 'this is your task' prompt", () => {
      const conv = new ConversationAggregate(makeCtx(), makeDeps());
      const prompt = conv.prepareForLaunch();
      expect(prompt).toContain("this is your task");
      expect(prompt).not.toContain("NEW INSTRUCTIONS");
      expect(prompt).not.toContain("Continue working");
    });

    it("wake with message returns 'NEW INSTRUCTIONS' prompt", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);
      conv.prepareForLaunch();
      conv.recordAgentExit(agentDone("Done"));
      const prompt = conv.prepareForLaunch({ newMessage: "Also do X" });
      expect(prompt).toContain("NEW INSTRUCTIONS");
    });

    it("wake without message returns 'Continue working' prompt", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);
      conv.prepareForLaunch();
      conv.recordAgentExit(agentDone("Done"));
      const prompt = conv.prepareForLaunch();
      expect(prompt).toContain("Continue working");
    });
  });

  // -------------------------------------------------------------------------
  // 7. Tracker issue metadata in TASK.md
  // -------------------------------------------------------------------------

  describe("tracker metadata", () => {
    it("includes priority, labels, status, source from tracker issue", () => {
      const ctx = makeCtx({
        trackerIssue: makeTrackerIssue({
          priority: 1,
          labels: ["critical", "security"],
          rawState: "In Review",
          source: "linear",
          url: "https://linear.app/team/INT-1",
        }),
      });
      const conv = new ConversationAggregate(ctx, makeDeps());
      conv.prepareForLaunch();

      const taskMd = readAgentFile("TASK.md");
      expect(taskMd).toContain("## Priorytet\n1");
      expect(taskMd).toContain("## Labelki\ncritical, security");
      expect(taskMd).toContain("## Status\nIn Review");
      expect(taskMd).toContain("## Source\nlinear");
      expect(taskMd).toContain("https://linear.app/team/INT-1");
    });
  });

  // -------------------------------------------------------------------------
  // 8. Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty new message gracefully", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);
      conv.prepareForLaunch();
      conv.recordAgentExit(agentDone("Done"));

      // Empty message should not be recorded
      conv.prepareForLaunch({ newMessage: "   " });
      const msgs = conv.getMessages();
      // initial + agent done (empty message skipped)
      expect(msgs).toHaveLength(2);
    });

    it("handles whitespace-only agent output", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);
      conv.prepareForLaunch();
      conv.recordAgentExit("   \n  \n  ");

      // Whitespace-only should not be recorded
      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(1);
    });

    it("records only last 50 lines of agent output", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);
      conv.prepareForLaunch();

      const longOutput = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n")
        + "\n```json\n{\"status\":\"done\",\"description\":\"done\"}\n```";
      conv.recordAgentExit(longOutput);

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(2);
      // Should have the tail (last 50 lines), including the JSON
      const lines = msgs[1].text.split("\n");
      expect(lines.length).toBeLessThanOrEqual(50);
      expect(msgs[1].text).toContain("done");
    });

    it("deleteMessage removes from disk and returns updated list", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);
      conv.prepareForLaunch();
      conv.recordAgentExit(agentDone("Round 1"));
      conv.prepareForLaunch({ newMessage: "Do more" });
      conv.recordAgentExit(agentDone("Round 2"));

      // Delete the second message (first agent response)
      const remaining = conv.deleteMessage(1);
      expect(remaining).toHaveLength(3); // was 4, now 3
      expect(remaining[0].role).toBe("human");
      expect(remaining[1].role).toBe("human"); // "Do more"
      expect(remaining[2].role).toBe("agent");  // Round 2
    });

    it("handles special characters in messages", () => {
      const ctx = makeCtx();
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);
      conv.prepareForLaunch();
      conv.recordAgentExit(agentDone("Done"));

      const specialMsg = "Fix the regex: /[a-z]+\\.\\d{3}/ and the template `${name}`";
      conv.prepareForLaunch({ newMessage: specialMsg });

      const taskMd = readAgentFile("TASK.md");
      expect(taskMd).toContain(specialMsg);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Task forcing agent errors (intentionally bad tasks)
  // -------------------------------------------------------------------------

  describe("intentionally problematic tasks", () => {
    it("vague task that forces agent to ask for details", () => {
      const ctx = makeCtx({
        title: "Improve performance",
        description: "Make it faster",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      conv.prepareForLaunch();

      // Agent should ask what to optimize
      conv.recordAgentExit(agentNeedInfo(
        "The task is too vague. Which part of the system should I optimize? " +
        "Frontend rendering? API response time? Database queries? " +
        "Please provide specific metrics or pages that are slow."
      ));

      const msgs = conv.getMessages();
      expect(msgs[1].text).toContain("too vague");

      // Human clarifies with image reference
      conv.prepareForLaunch({
        newMessage: "API response time on /api/products. Currently 3s, target is 200ms. " +
          "See profiling: ![profile](/api/projects/myproject/agents/INT-1/images/img-1.png)",
      });

      const taskMd = readAgentFile("TASK.md");
      expect(taskMd).toContain("too vague");
      expect(taskMd).toContain("target is 200ms");
      expect(taskMd).toContain(".10timesdev/images/img-1.png");
    });

    it("task referencing nonexistent files — agent reports error", () => {
      const ctx = makeCtx({
        title: "Fix bug in auth.py",
        description: "Fix the authentication bug in src/auth.py line 42",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      conv.prepareForLaunch();
      conv.recordAgentExit(agentError(
        "File src/auth.py does not exist. This project uses TypeScript, not Python. " +
        "Did you mean src/auth.ts?"
      ));

      const msgs = conv.getMessages();
      expect(msgs[1].text).toContain("does not exist");

      conv.prepareForLaunch({
        newMessage: "Yes, fix src/auth.ts instead",
      });

      conv.recordAgentExit(agentDone("Fixed authentication bug in src/auth.ts"));

      conv.prepareForLaunch();
      const taskMd = readAgentFile("TASK.md");
      expect(taskMd).toContain("does not exist");
      expect(taskMd).toContain("src/auth.ts instead");
      expect(taskMd).toContain("Fixed authentication bug");
    });

    it("task that causes build failure — agent recovers", () => {
      const ctx = makeCtx({
        title: "Add new API route",
        description: "Add POST /api/widgets endpoint with validation",
      });
      const conv = new ConversationAggregate(ctx, makeDeps());
      seedInitialMessage(conv, ctx);

      conv.prepareForLaunch();

      // Agent reports build error
      conv.recordAgentExit(agentError(
        "Build failed: TS2339 Property 'widgets' does not exist on type 'PrismaClient'. " +
        "Need to run prisma generate first but cannot find schema.prisma."
      ));

      conv.prepareForLaunch({
        newMessage: "The schema is at prisma/schema.prisma. Add Widget model first, then generate.",
      });

      conv.recordAgentExit(agentDone("Added Widget model to schema, ran prisma generate, created POST /api/widgets"));

      const msgs = conv.getMessages();
      expect(msgs).toHaveLength(4);
      expect(msgs[3].text).toContain("Widget model");
    });
  });
});
