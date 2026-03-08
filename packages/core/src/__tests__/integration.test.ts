import { describe, it, expect, vi, beforeEach } from "vitest";
import { BoundIssue } from "../bound-issue.js";
import { TypedEventBus } from "../event-bus.js";
import type { TrackerIssue, TrackerPhase, TrackerComment, ProviderTypeSchema, EventMap } from "@orchestrator/contracts";
import { BaseTracker, BaseAIProvider, BaseIMProvider, type AIProviderDriver } from "@orchestrator/contracts";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId: "ext-1",
    identifier: "TEST-1",
    title: "Test issue",
    description: "Desc",
    priority: 2,
    phase: "todo",
    rawState: "Todo",
    labels: ["agent"],
    createdBy: "User",
    url: "https://example.com",
    source: "test",
    comments: [],
    _raw: {},
    ...overrides,
  };
}

// A full-featured mock tracker for integration tests
class FullTracker extends BaseTracker {
  readonly name = "full";
  readonly schema: ProviderTypeSchema = { type: "full", category: "tracker", displayName: "Full", fields: [] };
  override readonly canTransitionState = true;
  override readonly canComment = true;
  override readonly canDetectWake = true;
  override readonly canManageLabels = true;

  transitions: Array<{ phase: TrackerPhase }> = [];
  commentsAdded: string[] = [];
  storedComments: TrackerComment[] = [];
  issues = new Map<string, TrackerIssue>();

  async pollIssues(): Promise<TrackerIssue[]> {
    return Array.from(this.issues.values());
  }

  override async transitionTo(_config: Record<string, string>, _issue: TrackerIssue, phase: TrackerPhase) {
    this.transitions.push({ phase });
  }

  override async addComment(_config: Record<string, string>, _issue: TrackerIssue, body: string) {
    this.commentsAdded.push(body);
  }

  override async getComments(): Promise<TrackerComment[]> {
    return this.storedComments;
  }

  override hasLabel(issue: TrackerIssue, label: string): boolean {
    return issue.labels.includes(label);
  }

  override async getIssue(_config: Record<string, string>, externalId: string): Promise<TrackerIssue | null> {
    return this.issues.get(externalId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Integration: BoundIssue + Tracker lifecycle
// ---------------------------------------------------------------------------

describe("Integration: BoundIssue + Tracker lifecycle", () => {
  let tracker: FullTracker;
  const config = { apiKey: "test-key" };

  beforeEach(() => {
    tracker = new FullTracker();
  });

  it("full lifecycle: poll → bind → transition → comment → reload", async () => {
    const issueData = makeIssue({ phase: "todo" });
    tracker.issues.set("ext-1", issueData);

    // 1. Poll issues
    const polled = await tracker.pollIssues(config);
    expect(polled).toHaveLength(1);

    // 2. Bind the issue
    const bound = new BoundIssue(polled[0], tracker, config, "/projects/test");
    expect(bound.identifier).toBe("TEST-1");
    expect(bound.phase).toBe("todo");
    expect(bound.projectPath).toBe("/projects/test");

    // 3. Transition to in_progress
    await bound.transitionTo("in_progress");
    expect(tracker.transitions).toHaveLength(1);
    expect(tracker.transitions[0].phase).toBe("in_progress");

    // 4. Add a comment
    await bound.addComment("Working on it");
    expect(tracker.commentsAdded).toEqual(["Working on it"]);

    // 5. Simulate state change on remote, reload
    tracker.issues.set("ext-1", makeIssue({ phase: "in_progress", title: "Updated title" }));
    const reloaded = await bound.reload();
    expect(reloaded).not.toBeNull();
    expect(reloaded!.phase).toBe("in_progress");
    expect(reloaded!.title).toBe("Updated title");
    expect(reloaded!.projectPath).toBe("/projects/test");
  });

  it("multiple transitions through full workflow", async () => {
    const issueData = makeIssue();
    const bound = new BoundIssue(issueData, tracker, config, "/proj");

    const phases: TrackerPhase[] = ["in_progress", "in_review", "done"];
    for (const phase of phases) {
      await bound.transitionTo(phase);
    }

    expect(tracker.transitions.map((t) => t.phase)).toEqual(["in_progress", "in_review", "done"]);
  });

  it("wake detection: getComments returns new human comments", async () => {
    tracker.storedComments = [
      { body: "Please also fix the header", authorName: "Human", isBot: false, createdAt: "2026-01-02T00:00:00Z" },
    ];

    const bound = new BoundIssue(makeIssue(), tracker, config, "/proj");
    const comments = await bound.getComments();
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("Please also fix the header");
    expect(comments[0].isBot).toBe(false);
  });

  it("reload returns null when issue deleted remotely", async () => {
    // Issue doesn't exist in tracker
    const bound = new BoundIssue(makeIssue(), tracker, config, "/proj");
    const reloaded = await bound.reload();
    expect(reloaded).toBeNull();
  });

  it("label checking works through BoundIssue", () => {
    const bound = new BoundIssue(makeIssue({ labels: ["agent", "preview"] }), tracker, config, "/proj");
    expect(bound.hasLabel("agent")).toBe(true);
    expect(bound.hasLabel("preview")).toBe(true);
    expect(bound.hasLabel("missing")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: EventBus cross-component communication
// ---------------------------------------------------------------------------

describe("Integration: EventBus cross-component communication", () => {
  it("simulates agent lifecycle events across components", () => {
    const bus = new TypedEventBus<EventMap>();
    const events: string[] = [];

    // Component A: tracker monitor
    bus.on("agent:spawned", (data) => {
      events.push(`spawned:${data.issueId}`);
    });

    // Component B: notification service
    bus.on("agent:done", (data) => {
      events.push(`done:${data.issueId}`);
    });

    // Component C: state cleanup
    bus.on("agent:error", (data) => {
      events.push(`error:${data.issueId}`);
    });

    // Simulate lifecycle
    bus.emit("agent:spawned", { issueId: "ISS-1", projectPath: "/p" });
    bus.emit("agent:done", { issueId: "ISS-1", projectPath: "/p" });
    bus.emit("agent:error", { issueId: "ISS-2", projectPath: "/p", error: "crashed" });

    expect(events).toEqual(["spawned:ISS-1", "done:ISS-1", "error:ISS-2"]);
  });

  it("unsubscribed listeners do not fire", () => {
    const bus = new TypedEventBus<EventMap>();
    const calls: string[] = [];

    const handler = () => calls.push("should-not-fire");
    bus.on("agent:spawned", handler);
    bus.off("agent:spawned", handler);

    bus.emit("agent:spawned", { issueId: "ISS-1", projectPath: "/p" });
    expect(calls).toEqual([]);
  });

  it("once listener fires exactly once", () => {
    const bus = new TypedEventBus<EventMap>();
    const calls: string[] = [];

    bus.once("agent:done", (data) => calls.push(data.issueId));

    bus.emit("agent:done", { issueId: "ISS-1", projectPath: "/p" });
    bus.emit("agent:done", { issueId: "ISS-2", projectPath: "/p" });

    expect(calls).toEqual(["ISS-1"]);
  });
});

// ---------------------------------------------------------------------------
// Integration: AI Provider driver contract
// ---------------------------------------------------------------------------

describe("Integration: AI Provider driver contract", () => {
  class TestAIProvider extends BaseAIProvider {
    readonly name = "test-ai";
    readonly schema: ProviderTypeSchema = {
      type: "test-ai",
      category: "ai",
      displayName: "Test AI",
      fields: [{ key: "model", label: "Model", type: "select", options: [{ label: "A", value: "a" }] }],
    };

    createDriver(config: Record<string, string>): AIProviderDriver {
      const model = config.model || "default-model";
      return {
        processPattern: "test-ai.*--auto",
        outputLogPath: "/tmp/test-ai.log",
        buildLaunchCommand(prompt: string) {
          const escaped = prompt.replace(/'/g, "'\\''");
          return `test-ai --model ${model} --auto '${escaped}' 2>&1 | tee /tmp/test-ai.log`;
        },
        buildEnvVars(projectConfig: Record<string, string>) {
          const vars = [`AI_MODEL=${model}`];
          if (projectConfig.apiKey) vars.push(`API_KEY=${projectConfig.apiKey}`);
          return vars;
        },
        filterOutput(raw: string) {
          return raw
            .split("\n")
            .filter((l) => !l.startsWith("[debug]"))
            .join("\n")
            .trim();
        },
      };
    }
  }

  it("driver produces consistent launch command", () => {
    const provider = new TestAIProvider();
    const driver = provider.createDriver({ model: "gpt-5" });

    const cmd = driver.buildLaunchCommand("fix the bug");
    expect(cmd).toContain("--model gpt-5");
    expect(cmd).toContain("fix the bug");
    expect(cmd).toContain("tee /tmp/test-ai.log");
  });

  it("driver escapes quotes in prompt", () => {
    const driver = new TestAIProvider().createDriver({});
    const cmd = driver.buildLaunchCommand("it's broken");
    expect(cmd).toContain("it'\\''s broken");
  });

  it("driver env vars include project config", () => {
    const driver = new TestAIProvider().createDriver({ model: "x" });
    const vars = driver.buildEnvVars({ apiKey: "sk-123" });
    expect(vars).toContain("AI_MODEL=x");
    expect(vars).toContain("API_KEY=sk-123");
  });

  it("driver filterOutput strips debug lines", () => {
    const driver = new TestAIProvider().createDriver({});
    const filtered = driver.filterOutput("[debug] init\nReal output\n[debug] done\nMore output");
    expect(filtered).toBe("Real output\nMore output");
  });
});

// ---------------------------------------------------------------------------
// Integration: Multiple trackers with BoundIssue
// ---------------------------------------------------------------------------

describe("Integration: Multiple trackers coexist", () => {
  it("BoundIssue binds to different tracker instances independently", async () => {
    const tracker1 = new FullTracker();
    const tracker2 = new FullTracker();

    const issue1 = makeIssue({ externalId: "ext-1", identifier: "LIN-1", source: "linear" });
    const issue2 = makeIssue({ externalId: "ext-2", identifier: "SENT-5", source: "sentry" });

    const bound1 = new BoundIssue(issue1, tracker1, { apiKey: "lin" }, "/proj");
    const bound2 = new BoundIssue(issue2, tracker2, { authToken: "sent" }, "/proj");

    await bound1.transitionTo("in_progress");
    await bound2.transitionTo("done");

    expect(tracker1.transitions).toEqual([{ phase: "in_progress" }]);
    expect(tracker2.transitions).toEqual([{ phase: "done" }]);

    await bound1.addComment("WIP");
    await bound2.addComment("Fixed");

    expect(tracker1.commentsAdded).toEqual(["WIP"]);
    expect(tracker2.commentsAdded).toEqual(["Fixed"]);
  });
});
