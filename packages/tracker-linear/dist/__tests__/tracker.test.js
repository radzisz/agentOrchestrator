import { describe, it, expect, vi, beforeEach } from "vitest";
import { LinearTracker } from "../tracker.js";
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
function linearApiResponse(data) {
    return { ok: true, json: () => Promise.resolve({ data }) };
}
function makeLinearIssue(overrides = {}) {
    return Object.assign({ id: "uuid-1", identifier: "UKR-101", title: "Fix login bug", description: "Users can't log in", priority: 2, url: "https://linear.app/team/UKR-101", state: { name: "Todo" }, labels: { nodes: [{ id: "l1", name: "agent" }] }, creator: { id: "u1", name: "John" }, assignee: { id: "u2", name: "Agent" }, comments: { nodes: [
                { body: "Please fix this", createdAt: "2026-01-01T00:00:00Z", user: { name: "John", isMe: false } },
                { body: "On it", createdAt: "2026-01-01T01:00:00Z", user: { name: "Bot", isMe: true } },
            ] }, attachments: { nodes: [] }, team: { id: "t1", key: "UKR" } }, overrides);
}
describe("LinearTracker", () => {
    let tracker;
    beforeEach(() => {
        tracker = new LinearTracker();
        mockFetch.mockReset();
    });
    it("has correct metadata", () => {
        expect(tracker.name).toBe("linear");
        expect(tracker.schema.category).toBe("tracker");
        expect(tracker.schema.displayName).toBe("Linear");
        expect(tracker.canTransitionState).toBe(true);
        expect(tracker.canComment).toBe(true);
        expect(tracker.canDetectWake).toBe(true);
        expect(tracker.canManageLabels).toBe(true);
    });
    it("schema has required fields", () => {
        const requiredKeys = tracker.schema.fields.filter((f) => f.required).map((f) => f.key);
        expect(requiredKeys).toContain("apiKey");
        expect(requiredKeys).toContain("teamId");
    });
    describe("pollIssues", () => {
        it("returns empty when no apiKey", async () => {
            const result = await tracker.pollIssues({});
            expect(result).toEqual([]);
            expect(mockFetch).not.toHaveBeenCalled();
        });
        it("returns empty when no teamId or teamKey", async () => {
            const result = await tracker.pollIssues({ apiKey: "key" });
            expect(result).toEqual([]);
        });
        it("polls by label (default mode)", async () => {
            mockFetch.mockResolvedValue(linearApiResponse({
                issues: { nodes: [makeLinearIssue()] },
            }));
            const result = await tracker.pollIssues({
                apiKey: "lin_api_test",
                teamId: "team-uuid",
                label: "agent",
            });
            expect(result).toHaveLength(1);
            expect(result[0].identifier).toBe("UKR-101");
            expect(result[0].title).toBe("Fix login bug");
            expect(result[0].phase).toBe("todo");
            expect(result[0].source).toBe("linear");
            expect(result[0].labels).toEqual(["agent"]);
            expect(result[0].createdBy).toBe("John");
            // Verify fetch was called with correct auth
            expect(mockFetch).toHaveBeenCalledWith("https://api.linear.app/graphql", expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({ Authorization: "lin_api_test" }),
            }));
        });
        it("polls by assignee when detectionMode=assignee", async () => {
            mockFetch.mockResolvedValue(linearApiResponse({
                issues: { nodes: [makeLinearIssue()] },
            }));
            await tracker.pollIssues({
                apiKey: "key",
                teamId: "t1",
                detectionMode: "assignee",
                assigneeId: "u2",
            });
            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.variables).toEqual({ teamId: "t1", assigneeId: "u2" });
        });
        it("resolves teamId from teamKey when teamId missing", async () => {
            // First call: resolveTeam
            mockFetch.mockResolvedValueOnce(linearApiResponse({
                teams: { nodes: [{ id: "resolved-id", name: "Team", key: "UKR", organization: { urlKey: "org" } }] },
            }));
            // Second call: getAgentIssues
            mockFetch.mockResolvedValueOnce(linearApiResponse({
                issues: { nodes: [] },
            }));
            const onTeamResolved = vi.fn();
            tracker.onTeamResolved = onTeamResolved;
            await tracker.pollIssues({ apiKey: "key", teamKey: "UKR" });
            expect(onTeamResolved).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "key" }), "resolved-id");
        });
        it("filters out bot comments", async () => {
            mockFetch.mockResolvedValue(linearApiResponse({
                issues: { nodes: [makeLinearIssue()] },
            }));
            const result = await tracker.pollIssues({ apiKey: "key", teamId: "t1" });
            // Only non-bot comment should be included
            expect(result[0].comments).toHaveLength(1);
            expect(result[0].comments[0].authorName).toBe("John");
        });
        it("maps Linear states to tracker phases", async () => {
            const states = [
                { state: { name: "Backlog" }, expected: "todo" },
                { state: { name: "Todo" }, expected: "todo" },
                { state: { name: "In Progress" }, expected: "in_progress" },
                { state: { name: "In Review" }, expected: "in_review" },
                { state: { name: "Done" }, expected: "done" },
                { state: { name: "Cancelled" }, expected: "cancelled" },
            ];
            for (const { state, expected } of states) {
                mockFetch.mockResolvedValue(linearApiResponse({
                    issues: { nodes: [makeLinearIssue({ state })] },
                }));
                const result = await tracker.pollIssues({ apiKey: "key", teamId: "t1" });
                expect(result[0].phase).toBe(expected);
            }
        });
    });
    describe("transitionTo", () => {
        it("no-op without apiKey", async () => {
            await tracker.transitionTo({}, makeLinearIssue(), "done");
            expect(mockFetch).not.toHaveBeenCalled();
        });
        it("resolves state ID and updates issue", async () => {
            // getWorkflowStateId
            mockFetch.mockResolvedValueOnce(linearApiResponse({
                workflowStates: { nodes: [{ id: "state-done" }] },
            }));
            // updateIssueState
            mockFetch.mockResolvedValueOnce(linearApiResponse({
                issueUpdate: { success: true },
            }));
            const issue = { externalId: "uuid-1" };
            await tracker.transitionTo({ apiKey: "key", teamKey: "UKR" }, issue, "done");
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });
    describe("addComment", () => {
        it("sends comment via API", async () => {
            mockFetch.mockResolvedValue(linearApiResponse({ commentCreate: { success: true } }));
            const issue = { externalId: "uuid-1" };
            await tracker.addComment({ apiKey: "key" }, issue, "Hello");
            expect(mockFetch).toHaveBeenCalledOnce();
            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.variables.body).toBe("Hello");
        });
    });
    describe("getComments", () => {
        it("returns comments from _raw LinearIssue", async () => {
            const rawIssue = makeLinearIssue();
            const issue = { _raw: rawIssue };
            const comments = await tracker.getComments({}, issue);
            expect(comments).toHaveLength(2);
            expect(comments[0].authorName).toBe("John");
            expect(comments[0].isBot).toBe(false);
            expect(comments[1].authorName).toBe("Bot");
            expect(comments[1].isBot).toBe(true);
        });
    });
    describe("hasLabel", () => {
        it("checks labels array", () => {
            expect(tracker.hasLabel({ labels: ["agent", "preview"] }, "agent")).toBe(true);
            expect(tracker.hasLabel({ labels: ["agent"] }, "missing")).toBe(false);
        });
    });
    describe("reassignOnDone", () => {
        it("no-op when not in assignee mode", async () => {
            await tracker.reassignOnDone({ apiKey: "key", detectionMode: "label" }, makeLinearIssue());
            expect(mockFetch).not.toHaveBeenCalled();
        });
        it("reassigns to creator in assignee mode", async () => {
            mockFetch.mockResolvedValue(linearApiResponse({ issueUpdate: { success: true } }));
            const issue = {
                externalId: "uuid-1",
                _raw: makeLinearIssue({ creator: { id: "creator-1", name: "Creator" }, assignee: { id: "agent-1", name: "Agent" } }),
            };
            await tracker.reassignOnDone({ apiKey: "key", detectionMode: "assignee", reassignOnDone: "true" }, issue);
            expect(mockFetch).toHaveBeenCalledOnce();
        });
        it("skips if creator is already assignee", async () => {
            const issue = {
                externalId: "uuid-1",
                _raw: makeLinearIssue({ creator: { id: "same-user", name: "User" }, assignee: { id: "same-user", name: "User" } }),
            };
            await tracker.reassignOnDone({ apiKey: "key", detectionMode: "assignee" }, issue);
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });
    describe("getIssue", () => {
        it("fetches and converts a single issue", async () => {
            mockFetch.mockResolvedValue(linearApiResponse({
                issue: makeLinearIssue({ state: { name: "In Progress" } }),
            }));
            const result = await tracker.getIssue({ apiKey: "key" }, "uuid-1");
            expect(result).not.toBeNull();
            expect(result.identifier).toBe("UKR-101");
            expect(result.phase).toBe("in_progress");
        });
        it("returns null when issue not found", async () => {
            mockFetch.mockResolvedValue(linearApiResponse({ issue: null }));
            const result = await tracker.getIssue({ apiKey: "key" }, "missing");
            expect(result).toBeNull();
        });
    });
});
//# sourceMappingURL=tracker.test.js.map