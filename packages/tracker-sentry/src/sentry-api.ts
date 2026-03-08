// ---------------------------------------------------------------------------
// Sentry REST API client — pure API layer, no storage dependencies
// ---------------------------------------------------------------------------

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  permalink: string;
  level: string;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  metadata: { value?: string; message?: string };
  project: { slug: string; name: string };
  status: string;
  isUnhandled: boolean;
}

export async function listIssues(
  authToken: string,
  org: string,
  projectSlug: string,
  since?: string,
): Promise<SentryIssue[]> {
  const url = `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(projectSlug)}/issues/?query=is:unresolved&sort=date&limit=25`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!res.ok) {
    throw new Error(`Sentry API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }

  const issues: SentryIssue[] = await res.json();

  if (since) {
    const sinceDate = new Date(since).getTime();
    return issues.filter((i) => new Date(i.firstSeen).getTime() > sinceDate);
  }

  return issues;
}

export async function updateIssueStatus(
  authToken: string,
  issueId: string,
  status: "resolved" | "ignored" | "unresolved",
): Promise<void> {
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

export interface SentryProject {
  slug: string;
  name: string;
  id: string;
  platform: string | null;
}

export async function listProjects(
  authToken: string,
  org: string,
): Promise<SentryProject[]> {
  const res = await fetch(
    `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/projects/?per_page=100`,
    { headers: { Authorization: `Bearer ${authToken}` } },
  );
  if (!res.ok) return [];
  return await res.json();
}

export async function getProject(
  authToken: string,
  org: string,
  projectSlug: string,
): Promise<SentryProject | null> {
  const res = await fetch(
    `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(projectSlug)}/`,
    { headers: { Authorization: `Bearer ${authToken}` } },
  );
  if (!res.ok) return null;
  return await res.json();
}

export interface SentryEventSummary {
  url?: string;
  environment?: string;
  release?: string;
  browser?: string;
  transaction?: string;
  exceptions: Array<{ type: string; value: string; frames: string[] }>;
  breadcrumbs: string[];
}

export async function getLatestEventSummary(
  authToken: string,
  org: string,
  issueId: string,
): Promise<SentryEventSummary | null> {
  const res = await fetch(
    `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/issues/${issueId}/events/latest/`,
    { headers: { Authorization: `Bearer ${authToken}` } },
  );
  if (!res.ok) return null;

  const ev = await res.json();
  const summary: SentryEventSummary = { exceptions: [], breadcrumbs: [] };

  for (const t of ev.tags || []) {
    if (t.key === "url") summary.url = t.value;
    else if (t.key === "environment") summary.environment = t.value;
    else if (t.key === "release") summary.release = t.value;
    else if (t.key === "browser") summary.browser = t.value;
    else if (t.key === "transaction") summary.transaction = t.value;
  }

  for (const entry of ev.entries || []) {
    if (entry.type === "exception") {
      for (const exc of entry.data?.values || []) {
        const frames: string[] = [];
        const appFrames = (exc.stacktrace?.frames || []).filter((f: { inApp?: boolean }) => f.inApp);
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
      const crumbs = (entry.data?.values || []).slice(-10);
      for (const c of crumbs) {
        const msg = c.message || c.data?.url || "";
        if (msg) summary.breadcrumbs.push(`[${c.category || c.type}] ${msg}`);
      }
    }
  }

  return summary;
}

export async function getIssue(
  authToken: string,
  issueId: string,
): Promise<SentryIssue | null> {
  const res = await fetch(`https://sentry.io/api/0/issues/${issueId}/`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Sentry API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }

  return await res.json();
}
