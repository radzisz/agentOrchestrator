// ---------------------------------------------------------------------------
// Sentry REST API client — pure API layer, no storage dependencies
// ---------------------------------------------------------------------------
export async function listIssues(authToken, org, projectSlug, since) {
    const url = `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(projectSlug)}/issues/?query=is:unresolved&sort=date&limit=25`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
        throw new Error(`Sentry API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    }
    const issues = await res.json();
    if (since) {
        const sinceDate = new Date(since).getTime();
        return issues.filter((i) => new Date(i.firstSeen).getTime() > sinceDate);
    }
    return issues;
}
export async function updateIssueStatus(authToken, issueId, status) {
    const res = await fetch(`https://sentry.io/api/0/issues/${issueId}/`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
    });
    if (!res.ok) {
        throw new Error(`Sentry API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    }
}
export async function listProjects(authToken, org) {
    const res = await fetch(`https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/projects/?per_page=100`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok)
        return [];
    return await res.json();
}
export async function getProject(authToken, org, projectSlug) {
    const res = await fetch(`https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(projectSlug)}/`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok)
        return null;
    return await res.json();
}
export async function getLatestEventSummary(authToken, org, issueId) {
    var _a, _b, _c, _d;
    const res = await fetch(`https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/issues/${issueId}/events/latest/`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok)
        return null;
    const ev = await res.json();
    const summary = { exceptions: [], breadcrumbs: [] };
    for (const t of ev.tags || []) {
        if (t.key === "url")
            summary.url = t.value;
        else if (t.key === "environment")
            summary.environment = t.value;
        else if (t.key === "release")
            summary.release = t.value;
        else if (t.key === "browser")
            summary.browser = t.value;
        else if (t.key === "transaction")
            summary.transaction = t.value;
    }
    for (const entry of ev.entries || []) {
        if (entry.type === "exception") {
            for (const exc of ((_a = entry.data) === null || _a === void 0 ? void 0 : _a.values) || []) {
                const frames = [];
                const appFrames = (((_b = exc.stacktrace) === null || _b === void 0 ? void 0 : _b.frames) || []).filter((f) => f.inApp);
                for (const f of appFrames.slice(-10)) {
                    let line = `${f.filename || "?"}:${f.lineNo || "?"} in ${f.function || "?"}`;
                    if (f.context) {
                        for (const [lineNo, code] of f.context) {
                            line += `\n      ${lineNo}: ${code}`;
                        }
                    }
                    frames.push(line);
                }
                summary.exceptions.push({
                    type: exc.type || "Error",
                    value: exc.value || "",
                    frames,
                });
            }
        }
        if (entry.type === "breadcrumbs") {
            const crumbs = (((_c = entry.data) === null || _c === void 0 ? void 0 : _c.values) || []).slice(-10);
            for (const c of crumbs) {
                const msg = c.message || ((_d = c.data) === null || _d === void 0 ? void 0 : _d.url) || "";
                if (msg)
                    summary.breadcrumbs.push(`[${c.category || c.type}] ${msg}`);
            }
        }
    }
    return summary;
}
export async function getIssue(authToken, issueId) {
    const res = await fetch(`https://sentry.io/api/0/issues/${issueId}/`, {
        headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.status === 404)
        return null;
    if (!res.ok) {
        throw new Error(`Sentry API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    }
    return await res.json();
}
//# sourceMappingURL=sentry-api.js.map