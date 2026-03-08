import { describe, it, expect, vi } from "vitest";
import { BoundIssue } from "../bound-issue.js";
import type { TrackerIssue, TrackerPhase, ProviderTypeSchema } from "@orchestrator/contracts";
import { BaseTracker } from "@orchestrator/contracts";

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId: "ext-1",
    identifier: "TEST-1",
    title: "Test issue",
    description: "Desc",
    priority: 2,
    phase: "todo",
    rawState: "Todo",
    labels: ["agent", "preview"],
    createdBy: "User",
    url: "https://example.com",
    source: "test",
    comments: [],
    _raw: {},
    ...overrides,
  };
}

class MockTracker extends BaseTracker {
  readonly name = "mock";
  readonly schema: ProviderTypeSchema = { type: "mock", category: "tracker", displayName: "Mock", fields: [] };
  override readonly canTransitionState = true;
  override readonly canComment = true;
  override readonly canDetectWake = true;
  override readonly canManageLabels = true;

  transitionToFn = vi.fn();
  addCommentFn = vi.fn();
  getCommentsFn = vi.fn().mockResolvedValue([]);
  getIssueFn = vi.fn();

  async pollIssues(): Promise<TrackerIssue[]> { return []; }

  override async transitionTo(config: Record<string, string>, issue: TrackerIssue, phase: TrackerPhase) {
    this.transitionToFn(config, issue, phase);
  }

  override async addComment(config: Record<string, string>, issue: TrackerIssue, body: string) {
    this.addCommentFn(config, issue, body);
  }

  override async getComments(config: Record<string, string>, issue: TrackerIssue) {
    return this.getCommentsFn(config, issue);
  }

  override hasLabel(issue: TrackerIssue, label: string): boolean {
    return issue.labels.includes(label);
  }

  override async getIssue(config: Record<string, string>, externalId: string): Promise<TrackerIssue | null> {
    return this.getIssueFn(config, externalId);
  }
}

describe("BoundIssue", () => {
  it("delegates TrackerIssue fields", () => {
    const data = makeIssue({ title: "My Title", priority: 1 });
    const bound = new BoundIssue(data, new MockTracker(), {}, "/proj");
    expect(bound.externalId).toBe("ext-1");
    expect(bound.identifier).toBe("TEST-1");
    expect(bound.title).toBe("My Title");
    expect(bound.priority).toBe(1);
    expect(bound.phase).toBe("todo");
    expect(bound.labels).toEqual(["agent", "preview"]);
    expect(bound.source).toBe("test");
    expect(bound.projectPath).toBe("/proj");
  });

  it("exposes tracker capabilities", () => {
    const tracker = new MockTracker();
    const bound = new BoundIssue(makeIssue(), tracker, {}, "/proj");
    expect(bound.canTransitionState).toBe(true);
    expect(bound.canComment).toBe(true);
    expect(bound.canDetectWake).toBe(true);
    expect(bound.canManageLabels).toBe(true);
  });

  it("transitionTo passes config and issue to tracker", async () => {
    const tracker = new MockTracker();
    const config = { apiKey: "key-123" };
    const issue = makeIssue();
    const bound = new BoundIssue(issue, tracker, config, "/proj");

    await bound.transitionTo("done");
    expect(tracker.transitionToFn).toHaveBeenCalledWith(config, issue, "done");
  });

  it("transitionTo is no-op when tracker can't transition", async () => {
    class NoTransition extends MockTracker {
      override readonly canTransitionState = false;
    }
    const tracker = new NoTransition();
    const bound = new BoundIssue(makeIssue(), tracker, {}, "/proj");
    await bound.transitionTo("done");
    expect(tracker.transitionToFn).not.toHaveBeenCalled();
  });

  it("addComment passes config and body to tracker", async () => {
    const tracker = new MockTracker();
    const config = { apiKey: "key" };
    const issue = makeIssue();
    const bound = new BoundIssue(issue, tracker, config, "/proj");

    await bound.addComment("Hello world");
    expect(tracker.addCommentFn).toHaveBeenCalledWith(config, issue, "Hello world");
  });

  it("addComment is no-op when tracker can't comment", async () => {
    class NoComment extends MockTracker {
      override readonly canComment = false;
    }
    const tracker = new NoComment();
    const bound = new BoundIssue(makeIssue(), tracker, {}, "/proj");
    await bound.addComment("test");
    expect(tracker.addCommentFn).not.toHaveBeenCalled();
  });

  it("getComments returns empty when tracker can't detect wake", async () => {
    class NoWake extends MockTracker {
      override readonly canDetectWake = false;
    }
    const tracker = new NoWake();
    const bound = new BoundIssue(makeIssue(), tracker, {}, "/proj");
    const comments = await bound.getComments();
    expect(comments).toEqual([]);
    expect(tracker.getCommentsFn).not.toHaveBeenCalled();
  });

  it("hasLabel delegates to tracker", () => {
    const tracker = new MockTracker();
    const bound = new BoundIssue(makeIssue({ labels: ["agent", "preview"] }), tracker, {}, "/proj");
    expect(bound.hasLabel("agent")).toBe(true);
    expect(bound.hasLabel("missing")).toBe(false);
  });

  it("hasLabel returns false when tracker can't manage labels", () => {
    class NoLabels extends MockTracker {
      override readonly canManageLabels = false;
    }
    const tracker = new NoLabels();
    const bound = new BoundIssue(makeIssue({ labels: ["agent"] }), tracker, {}, "/proj");
    expect(bound.hasLabel("agent")).toBe(false);
  });

  it("reload returns new BoundIssue with fresh data", async () => {
    const tracker = new MockTracker();
    const freshIssue = makeIssue({ title: "Updated Title", phase: "done" });
    tracker.getIssueFn.mockResolvedValue(freshIssue);

    const config = { apiKey: "key" };
    const bound = new BoundIssue(makeIssue(), tracker, config, "/proj");
    const reloaded = await bound.reload();

    expect(reloaded).not.toBeNull();
    expect(reloaded!.title).toBe("Updated Title");
    expect(reloaded!.phase).toBe("done");
    expect(reloaded!.projectPath).toBe("/proj");
    expect(tracker.getIssueFn).toHaveBeenCalledWith(config, "ext-1");
  });

  it("reload returns null when issue not found", async () => {
    const tracker = new MockTracker();
    tracker.getIssueFn.mockResolvedValue(null);

    const bound = new BoundIssue(makeIssue(), tracker, {}, "/proj");
    const reloaded = await bound.reload();
    expect(reloaded).toBeNull();
  });
});
