import { describe, it, expect, vi, beforeEach } from "vitest";
import { SentryTracker, buildSentryIdentifier } from "../tracker.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function sentryResponse(data: any, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(data), text: () => Promise.resolve(JSON.stringify(data)) };
}

function makeSentryIssue(overrides: any = {}) {
  return {
    id: "12345",
    shortId: "UKRYTE-SKARBY-PANEL-39",
    title: "TypeError: Cannot read property 'map'",
    culprit: "components/UserList.tsx",
    permalink: "https://sentry.io/issues/12345/",
    level: "error",
    count: "42",
    userCount: 15,
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-03-01T00:00:00Z",
    metadata: { value: "Cannot read property 'map' of undefined" },
    project: { slug: "ukryte-skarby-panel", name: "USP" },
    status: "unresolved",
    isUnhandled: true,
    ...overrides,
  };
}

describe("SentryTracker", () => {
  let tracker: SentryTracker;

  beforeEach(() => {
    tracker = new SentryTracker();
    mockFetch.mockReset();
  });

  it("has correct metadata", () => {
    expect(tracker.name).toBe("sentry");
    expect(tracker.schema.category).toBe("tracker");
    expect(tracker.schema.displayName).toBe("Sentry");
    expect(tracker.canTransitionState).toBe(true);
    expect(tracker.canComment).toBe(false);
    expect(tracker.canDetectWake).toBe(false);
    expect(tracker.canManageLabels).toBe(false);
  });

  describe("pollIssues", () => {
    it("returns empty when config incomplete", async () => {
      expect(await tracker.pollIssues({})).toEqual([]);
      expect(await tracker.pollIssues({ authToken: "tok" })).toEqual([]);
      expect(await tracker.pollIssues({ authToken: "tok", org: "myorg" })).toEqual([]);
    });

    it("returns empty when mode is webhook", async () => {
      const result = await tracker.pollIssues({
        authToken: "tok", org: "myorg", projects: "proj", mode: "webhook",
      });
      expect(result).toEqual([]);
    });

    it("polls issues and builds short identifiers", async () => {
      mockFetch.mockResolvedValue(sentryResponse([makeSentryIssue()]));

      const result = await tracker.pollIssues({
        authToken: "tok",
        org: "myorg",
        projects: "ukryte-skarby-panel",
      });

      expect(result).toHaveLength(1);
      expect(result[0].identifier).toBe("USP-39");
      expect(result[0].title).toBe("[Sentry] TypeError: Cannot read property 'map'");
      expect(result[0].source).toBe("sentry");
      expect(result[0].priority).toBe(2); // error level
      expect(result[0].phase).toBe("todo");
      expect(result[0].url).toContain("sentry.io");
    });

    it("uses custom short names from config", async () => {
      mockFetch.mockResolvedValue(sentryResponse([makeSentryIssue()]));

      const result = await tracker.pollIssues({
        authToken: "tok",
        org: "myorg",
        projects: "ukryte-skarby-panel",
        projectShortNames: "ukryte-skarby-panel:PANEL",
      });

      expect(result[0].identifier).toBe("PANEL-39");
    });

    it("skips resolved and ignored issues", async () => {
      mockFetch.mockResolvedValue(sentryResponse([
        makeSentryIssue({ id: "1", status: "unresolved" }),
        makeSentryIssue({ id: "2", status: "resolved" }),
        makeSentryIssue({ id: "3", status: "ignored" }),
      ]));

      const result = await tracker.pollIssues({
        authToken: "tok", org: "myorg", projects: "proj",
      });
      expect(result).toHaveLength(1);
      expect(result[0].externalId).toBe("1");
    });

    it("polls multiple projects", async () => {
      mockFetch
        // proj-a: listIssues
        .mockResolvedValueOnce(sentryResponse([makeSentryIssue({ id: "a" })]))
        // proj-a: getLatestEventSummary for issue "a"
        .mockResolvedValueOnce(sentryResponse({ tags: [], entries: [] }))
        // proj-b: listIssues
        .mockResolvedValueOnce(sentryResponse([makeSentryIssue({ id: "b" })]))
        // proj-b: getLatestEventSummary for issue "b"
        .mockResolvedValueOnce(sentryResponse({ tags: [], entries: [] }));

      const result = await tracker.pollIssues({
        authToken: "tok", org: "myorg", projects: "proj-a,proj-b",
      });
      expect(result).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("handles fetch errors per project gracefully", async () => {
      mockFetch
        .mockResolvedValueOnce(sentryResponse(null, 500))
        .mockResolvedValueOnce(sentryResponse([makeSentryIssue()]));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await tracker.pollIssues({
        authToken: "tok", org: "myorg", projects: "failing,working",
      });
      expect(result).toHaveLength(1);
      consoleSpy.mockRestore();
    });

    it("maps priority from level", async () => {
      const levels = [
        { level: "fatal", expected: 1 },
        { level: "error", expected: 2 },
        { level: "warning", expected: 3 },
        { level: "info", expected: 3 },
      ];

      for (const { level, expected } of levels) {
        mockFetch.mockResolvedValue(sentryResponse([makeSentryIssue({ level })]));
        const result = await tracker.pollIssues({ authToken: "t", org: "o", projects: "p" });
        expect(result[0].priority).toBe(expected);
      }
    });
  });

  describe("transitionTo", () => {
    it("resolves to Sentry status and calls API", async () => {
      mockFetch.mockResolvedValue(sentryResponse({}));
      const issue = { externalId: "12345" } as any;
      await tracker.transitionTo!({ authToken: "tok" }, issue, "done");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://sentry.io/api/0/issues/12345/",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ status: "resolved" }),
        }),
      );
    });

    it("maps phases to sentry statuses", async () => {
      const mapping: Array<[string, string]> = [
        ["done", "resolved"],
        ["cancelled", "ignored"],
        ["todo", "unresolved"],
      ];

      for (const [phase, sentryStatus] of mapping) {
        mockFetch.mockResolvedValue(sentryResponse({}));
        await tracker.transitionTo!({ authToken: "tok" }, { externalId: "1" } as any, phase as any);
        const body = JSON.parse(mockFetch.mock.lastCall![1].body);
        expect(body.status).toBe(sentryStatus);
      }
    });

    it("no-op for in_progress/in_review phases", async () => {
      await tracker.transitionTo!({ authToken: "tok" }, { externalId: "1" } as any, "in_progress");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("getIssue", () => {
    it("fetches and converts a single issue", async () => {
      mockFetch.mockResolvedValue(sentryResponse(makeSentryIssue()));
      const result = await tracker.getIssue!({ authToken: "tok" }, "12345");
      expect(result).not.toBeNull();
      expect(result!.identifier).toBe("USP-39");
    });

    it("returns null on 404", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("") });
      const result = await tracker.getIssue!({ authToken: "tok" }, "missing");
      expect(result).toBeNull();
    });
  });
});

describe("buildSentryIdentifier", () => {
  it("auto-generates short name from slug", () => {
    expect(buildSentryIdentifier("UKRYTE-SKARBY-PANEL-39", "ukryte-skarby-panel")).toBe("USP-39");
  });

  it("uses custom short name", () => {
    expect(buildSentryIdentifier("UKRYTE-SKARBY-PANEL-39", "ukryte-skarby-panel", "ukryte-skarby-panel:PANEL")).toBe("PANEL-39");
  });

  it("handles multiple custom names", () => {
    expect(buildSentryIdentifier("MY-APP-5", "my-app", "my-app:APP,other:O")).toBe("APP-5");
  });

  it("handles single-word slugs", () => {
    expect(buildSentryIdentifier("BACKEND-12", "backend")).toBe("B-12");
  });

  it("extracts sequence from non-matching prefix", () => {
    // When shortId doesn't start with slug uppercase
    expect(buildSentryIdentifier("WEIRD-42", "other-slug")).toBe("OS-42");
  });
});
