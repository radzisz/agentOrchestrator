import { describe, it, expect } from "vitest";
import { BaseTracker, type TrackerIssue, type TrackerPhase, type ProviderTypeSchema } from "../tracker.js";

class TestTracker extends BaseTracker {
  readonly name = "test";
  readonly schema: ProviderTypeSchema = {
    type: "test",
    category: "tracker",
    displayName: "Test Tracker",
    fields: [],
  };

  override readonly canTransitionState = true;
  override readonly canManageLabels = true;

  private _issues: TrackerIssue[] = [];
  private _transitions: Array<{ issueId: string; phase: TrackerPhase }> = [];

  setIssues(issues: TrackerIssue[]) { this._issues = issues; }
  get transitions() { return this._transitions; }

  async pollIssues(): Promise<TrackerIssue[]> {
    return this._issues;
  }

  override async transitionTo(_config: Record<string, string>, issue: TrackerIssue, phase: TrackerPhase): Promise<void> {
    this._transitions.push({ issueId: issue.externalId, phase });
  }

  override hasLabel(issue: TrackerIssue, label: string): boolean {
    return issue.labels.includes(label);
  }
}

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId: "ext-1",
    identifier: "TEST-1",
    title: "Test issue",
    description: "Description",
    priority: 2,
    phase: "todo",
    rawState: "Todo",
    labels: ["agent"],
    createdBy: "User",
    createdAt: "2026-01-15T10:00:00.000Z",
    url: "https://example.com",
    source: "test",
    comments: [],
    _raw: {},
    ...overrides,
  };
}

describe("BaseTracker", () => {
  it("defaults all capabilities to false", () => {
    class MinimalTracker extends BaseTracker {
      readonly name = "minimal";
      readonly schema: ProviderTypeSchema = { type: "minimal", category: "tracker", displayName: "M", fields: [] };
      async pollIssues(): Promise<TrackerIssue[]> { return []; }
    }
    const t = new MinimalTracker();
    expect(t.canTransitionState).toBe(false);
    expect(t.canComment).toBe(false);
    expect(t.canDetectWake).toBe(false);
    expect(t.canManageLabels).toBe(false);
  });

  it("allows overriding capabilities", () => {
    const t = new TestTracker();
    expect(t.canTransitionState).toBe(true);
    expect(t.canManageLabels).toBe(true);
    expect(t.canComment).toBe(false);
  });

  it("pollIssues returns configured issues", async () => {
    const t = new TestTracker();
    const issues = [makeIssue(), makeIssue({ externalId: "ext-2", identifier: "TEST-2" })];
    t.setIssues(issues);
    const result = await t.pollIssues({}, "/tmp");
    expect(result).toHaveLength(2);
    expect(result[0].identifier).toBe("TEST-1");
  });

  it("transitionTo records transitions", async () => {
    const t = new TestTracker();
    const issue = makeIssue();
    await t.transitionTo!({}, issue, "done");
    expect(t.transitions).toEqual([{ issueId: "ext-1", phase: "done" }]);
  });

  it("hasLabel checks issue labels", () => {
    const t = new TestTracker();
    const issue = makeIssue({ labels: ["agent", "preview"] });
    expect(t.hasLabel!(issue, "agent")).toBe(true);
    expect(t.hasLabel!(issue, "preview")).toBe(true);
    expect(t.hasLabel!(issue, "missing")).toBe(false);
  });
});
