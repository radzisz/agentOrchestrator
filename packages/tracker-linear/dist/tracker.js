// ---------------------------------------------------------------------------
// LinearTracker — implements BaseTracker with config-as-parameter
// ---------------------------------------------------------------------------
import { BaseTracker, } from "@orchestrator/contracts";
import * as linear from "./linear-api";
function linearStateToPhase(stateName) {
    const lower = stateName.toLowerCase();
    if (["todo", "backlog", "unstarted"].some((s) => lower.includes(s)))
        return "todo";
    if (lower.includes("in progress"))
        return "in_progress";
    if (lower.includes("in review"))
        return "in_review";
    if (lower.includes("done"))
        return "done";
    if (lower.includes("cancel"))
        return "cancelled";
    return "todo";
}
function phaseToLinearState(phase) {
    switch (phase) {
        case "todo": return "Todo";
        case "in_progress": return "In Progress";
        case "in_review": return "In Review";
        case "done": return "Done";
        case "cancelled": return "Cancelled";
    }
}
function linearIssueToTracker(issue) {
    var _a, _b, _c, _d;
    const comments = (((_a = issue.comments) === null || _a === void 0 ? void 0 : _a.nodes) || [])
        .filter((c) => !c.user.isMe)
        .map((c) => ({
        body: c.body,
        createdAt: c.createdAt,
        authorName: c.user.name,
        isBot: false,
    }));
    return {
        externalId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        phase: linearStateToPhase(issue.state.name),
        rawState: issue.state.name,
        labels: issue.labels.nodes.map((l) => l.name),
        createdBy: (_c = (_b = issue.creator) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : null,
        createdAt: (_d = issue.createdAt) !== null && _d !== void 0 ? _d : null,
        url: issue.url || null,
        source: "linear",
        comments,
        _raw: issue,
    };
}
export const linearSchema = {
    type: "linear",
    category: "tracker",
    displayName: "Linear",
    fields: [
        { key: "mode", label: "Integration Mode", type: "select", required: true, default: "poll", options: [
                { label: "Poll", value: "poll" },
                { label: "Webhook", value: "webhook" },
            ] },
        { key: "apiKey", label: "API Key", type: "secret", required: true, description: "Linear API key (lin_api_...)", visibleWhen: { field: "mode", value: "poll" } },
        { key: "pollInterval", label: "Poll Interval", type: "select", default: "60000", visibleWhen: { field: "mode", value: "poll" }, options: [
                { label: "1 minute", value: "60000" },
                { label: "5 minutes", value: "300000" },
                { label: "30 minutes", value: "1800000" },
                { label: "60 minutes", value: "3600000" },
            ] },
        { key: "teamId", label: "Team", type: "string", required: true, projectOverride: true, description: "Linear team ID" },
        { key: "teamKey", label: "Team Key", type: "string", projectOverride: true, description: "Auto-resolved from team selection" },
        { key: "label", label: "Detection Label", type: "string", default: "agent", projectOverride: true, description: "Label to detect agent issues" },
        { key: "previewLabel", label: "Preview Label", type: "string", projectOverride: true, description: "Label for auto-deploy remote preview" },
        { key: "assigneeId", label: "Assignee ID", type: "string", projectOverride: true, description: "Filter by assignee instead of label" },
        { key: "assigneeName", label: "Assignee Name", type: "string", projectOverride: true },
        { key: "detectionMode", label: "Detection Mode", type: "select", default: "label", options: [
                { label: "By Label", value: "label" },
                { label: "By Assignee", value: "assignee" },
            ], projectOverride: true },
        { key: "reassignOnDone", label: "Reassign to creator on done", type: "select", default: "true", options: [
                { label: "Yes", value: "true" },
                { label: "No", value: "false" },
            ], projectOverride: true, visibleWhen: { field: "detectionMode", value: "assignee" } },
        { key: "projectIds", label: "Projects", type: "string", projectOverride: true, description: "Comma-separated Linear project IDs" },
    ],
};
export class LinearTracker extends BaseTracker {
    constructor() {
        super(...arguments);
        this.name = "linear";
        this.schema = linearSchema;
        this.canTransitionState = true;
        this.canComment = true;
        this.canDetectWake = true;
        this.canManageLabels = true;
    }
    async pollIssues(config) {
        var _a;
        const apiKey = config.apiKey;
        if (!apiKey)
            return [];
        let teamId = config.teamId;
        if (!teamId) {
            const teamKey = config.teamKey;
            if (!teamKey)
                return [];
            const team = await linear.resolveTeam(apiKey, teamKey);
            if (!team)
                return [];
            teamId = team.id;
            (_a = this.onTeamResolved) === null || _a === void 0 ? void 0 : _a.call(this, config, teamId);
        }
        const detectionMode = config.detectionMode || "label";
        let issues;
        if (detectionMode === "assignee" && config.assigneeId) {
            issues = await linear.getAssignedIssues(apiKey, teamId, config.assigneeId);
        }
        else {
            issues = await linear.getAgentIssues(apiKey, teamId, config.label || "agent");
        }
        return issues.map(linearIssueToTracker);
    }
    async transitionTo(config, issue, phase) {
        const apiKey = config.apiKey;
        if (!apiKey)
            return;
        const teamKey = config.teamKey || config.teamId || "";
        const stateName = phaseToLinearState(phase);
        const stateId = await linear.getWorkflowStateId(apiKey, teamKey, stateName);
        if (stateId) {
            await linear.updateIssueState(apiKey, issue.externalId, stateId);
        }
    }
    async addComment(config, issue, body) {
        const apiKey = config.apiKey;
        if (!apiKey)
            return;
        await linear.addComment(apiKey, issue.externalId, body);
    }
    async getComments(_config, issue) {
        const raw = issue._raw;
        return raw.comments.nodes.map((c) => ({
            body: c.body,
            createdAt: c.createdAt,
            authorName: c.user.name,
            isBot: c.user.isMe,
        }));
    }
    hasLabel(issue, label) {
        return issue.labels.includes(label);
    }
    async reassignOnDone(config, issue) {
        var _a, _b;
        const apiKey = config.apiKey;
        if (!apiKey)
            return;
        if (config.detectionMode !== "assignee" || config.reassignOnDone === "false")
            return;
        const raw = issue._raw;
        const creatorId = (_a = raw.creator) === null || _a === void 0 ? void 0 : _a.id;
        if (!creatorId)
            return;
        if (((_b = raw.assignee) === null || _b === void 0 ? void 0 : _b.id) === creatorId)
            return;
        await linear.updateIssueAssignee(apiKey, issue.externalId, creatorId);
    }
    async getIssue(config, externalId) {
        const apiKey = config.apiKey;
        if (!apiKey)
            return null;
        const issue = await linear.getIssue(apiKey, externalId);
        if (!issue)
            return null;
        return linearIssueToTracker(issue);
    }
}
//# sourceMappingURL=tracker.js.map