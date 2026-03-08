// ---------------------------------------------------------------------------
// SentryTracker — implements BaseTracker with config-as-parameter
// ---------------------------------------------------------------------------
import { BaseTracker, } from "@orchestrator/contracts";
import * as sentry from "./sentry-api.js";
function autoShortName(slug) {
    return slug.split("-").map((w) => w[0]).join("").toUpperCase();
}
function extractSequence(shortId, projectSlug) {
    const prefix = projectSlug.toUpperCase() + "-";
    if (shortId.startsWith(prefix))
        return shortId.slice(prefix.length);
    const lastDash = shortId.lastIndexOf("-");
    return lastDash >= 0 ? shortId.slice(lastDash + 1) : shortId;
}
function parseShortNames(raw) {
    if (!raw)
        return {};
    const map = {};
    for (const part of raw.split(",")) {
        const [slug, short] = part.split(":").map((s) => s.trim());
        if (slug && short)
            map[slug] = short;
    }
    return map;
}
function buildIdentifier(issue, shortNames) {
    var _a;
    const slug = ((_a = issue.project) === null || _a === void 0 ? void 0 : _a.slug) || "unknown";
    const short = shortNames[slug] || autoShortName(slug);
    const seq = extractSequence(issue.shortId, slug);
    return `${short}-${seq}`;
}
export function buildSentryIdentifier(shortId, projectSlug, projectShortNamesRaw) {
    const shortNames = parseShortNames(projectShortNamesRaw);
    const short = shortNames[projectSlug] || autoShortName(projectSlug);
    const seq = extractSequence(shortId, projectSlug);
    return `${short}-${seq}`;
}
function sentryStatusToPhase(status) {
    switch (status) {
        case "resolved": return "done";
        case "ignored": return "cancelled";
        default: return "todo";
    }
}
function phaseToSentryStatus(phase) {
    switch (phase) {
        case "done": return "resolved";
        case "cancelled": return "ignored";
        case "todo": return "unresolved";
        default: return null;
    }
}
function formatEventSummary(ev) {
    const parts = [];
    if (ev.url)
        parts.push(`**URL:** ${ev.url}`);
    if (ev.environment)
        parts.push(`**Environment:** ${ev.environment}`);
    if (ev.browser)
        parts.push(`**Browser:** ${ev.browser}`);
    for (const exc of ev.exceptions) {
        parts.push("", `### ${exc.type}: ${exc.value}`, "");
        if (exc.frames.length > 0) {
            parts.push("```");
            parts.push(...exc.frames);
            parts.push("```");
        }
    }
    if (ev.breadcrumbs.length > 0) {
        parts.push("", "### Breadcrumbs", "");
        for (const b of ev.breadcrumbs) {
            parts.push(`- ${b}`);
        }
    }
    return parts.join("\n");
}
function sentryIssueToTracker(issue, shortNames = {}, eventSummary) {
    var _a, _b, _c;
    const sentryUrl = issue.permalink || `https://sentry.io/issues/${issue.id}/`;
    const description = [
        `**Sentry Issue**`,
        "",
        `**Project:** ${((_a = issue.project) === null || _a === void 0 ? void 0 : _a.slug) || "unknown"}`,
        `**Level:** ${issue.level || "error"}`,
        `**Events:** ${issue.count || 1}`,
        `**Users affected:** ${issue.userCount || "?"}`,
        "",
        issue.culprit ? `**Culprit:** \`${issue.culprit}\`` : "",
        "",
        sentryUrl ? `[View in Sentry](${sentryUrl})` : "",
        "",
        "---",
        "",
        ((_b = issue.metadata) === null || _b === void 0 ? void 0 : _b.value) || ((_c = issue.metadata) === null || _c === void 0 ? void 0 : _c.message) || "",
        ...(eventSummary ? ["", "---", "", formatEventSummary(eventSummary)] : []),
    ].filter(Boolean).join("\n");
    return {
        externalId: issue.id,
        identifier: buildIdentifier(issue, shortNames),
        title: `[Sentry] ${issue.title}`,
        description,
        priority: issue.level === "fatal" ? 1 : issue.level === "error" ? 2 : 3,
        phase: sentryStatusToPhase(issue.status),
        rawState: issue.status,
        labels: [],
        createdBy: null,
        url: sentryUrl,
        source: "sentry",
        comments: [],
        _raw: issue,
    };
}
export const sentrySchema = {
    type: "sentry",
    category: "tracker",
    displayName: "Sentry",
    fields: [
        { key: "mode", label: "Integration Mode", type: "select", required: true, default: "poll", options: [
                { label: "Poll", value: "poll" },
                { label: "Webhook", value: "webhook" },
            ] },
        { key: "authToken", label: "Auth Token", type: "secret", required: true, description: "Required scopes: project:read, project:write, org:read, event:read", visibleWhen: { field: "mode", value: "poll" } },
        { key: "pollInterval", label: "Poll Interval", type: "select", default: "300000", visibleWhen: { field: "mode", value: "poll" }, options: [
                { label: "1 minute", value: "60000" },
                { label: "5 minutes", value: "300000" },
                { label: "30 minutes", value: "1800000" },
                { label: "60 minutes", value: "3600000" },
            ] },
        { key: "org", label: "Organization", type: "string", required: true, projectOverride: true, description: "Sentry organization slug" },
        { key: "projects", label: "Sentry Projects", type: "string", projectOverride: true, description: "Comma-separated project slugs" },
        { key: "projectShortNames", label: "Project Short Names", type: "string", projectOverride: true, description: "Optional short names: slug:SHORT,slug2:AB (auto-generated from first letters if empty)" },
    ],
};
export class SentryTracker extends BaseTracker {
    constructor() {
        super(...arguments);
        this.name = "sentry";
        this.schema = sentrySchema;
        this.canTransitionState = true;
    }
    async pollIssues(config) {
        const authToken = config.authToken;
        const org = config.org;
        const mode = config.mode || "both";
        if (!authToken || !org || mode === "webhook")
            return [];
        const projects = config.projects
            ? config.projects.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
        if (projects.length === 0)
            return [];
        const shortNames = parseShortNames(config.projectShortNames);
        const results = [];
        for (const slug of projects) {
            try {
                const issues = await sentry.listIssues(authToken, org, slug);
                for (const issue of issues) {
                    if (issue.status === "resolved" || issue.status === "ignored")
                        continue;
                    const ev = await sentry.getLatestEventSummary(authToken, org, issue.id).catch(() => null);
                    results.push(sentryIssueToTracker(issue, shortNames, ev));
                }
            }
            catch (error) {
                console.error(`[sentry-tracker] poll error for ${slug}:`, error);
            }
        }
        return results;
    }
    async transitionTo(config, issue, phase) {
        const authToken = config.authToken;
        if (!authToken)
            return;
        const sentryStatus = phaseToSentryStatus(phase);
        if (!sentryStatus)
            return;
        await sentry.updateIssueStatus(authToken, issue.externalId, sentryStatus);
    }
    async getIssue(config, externalId) {
        const authToken = config.authToken;
        const org = config.org;
        if (!authToken)
            return null;
        const issue = await sentry.getIssue(authToken, externalId);
        if (!issue)
            return null;
        const shortNames = parseShortNames(config.projectShortNames);
        const ev = org ? await sentry.getLatestEventSummary(authToken, org, externalId).catch(() => null) : null;
        return sentryIssueToTracker(issue, shortNames, ev);
    }
}
//# sourceMappingURL=tracker.js.map