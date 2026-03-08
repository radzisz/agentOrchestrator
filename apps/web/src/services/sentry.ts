/**
 * Sentry API client — fetches unresolved issues for polling integration.
 */

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
  status: string; // "unresolved", "resolved", "ignored"
  isUnhandled: boolean;
}

/**
 * List unresolved issues for a Sentry project, optionally filtered by firstSeen.
 */
export async function listIssues(
  authToken: string,
  org: string,
  projectSlug: string,
  since?: string
): Promise<SentryIssue[]> {
  const url = `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(projectSlug)}/issues/?query=is:unresolved&sort=date&limit=25`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
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

/**
 * Update the status of a Sentry issue (resolve, ignore, unresolve).
 */
export async function updateIssueStatus(
  authToken: string,
  issueId: string,
  status: "resolved" | "ignored" | "unresolved"
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

/**
 * List all projects in a Sentry organization.
 * Requires org:read scope — returns empty array if forbidden.
 */
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

/**
 * Get a single Sentry project by slug. Returns null if not found / no access.
 */
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

// ---------------------------------------------------------------------------
// Event data — stacktrace, breadcrumbs, tags
// ---------------------------------------------------------------------------

export interface SentryEventSummary {
  url?: string;
  environment?: string;
  release?: string;
  browser?: string;
  transaction?: string;
  exceptions: Array<{ type: string; value: string; frames: string[] }>;
  breadcrumbs: string[];
}

/**
 * Fetch the latest event for an issue and extract useful debugging info.
 * Uses org-scoped endpoint which works with user tokens.
 */
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

  // Tags
  for (const t of ev.tags || []) {
    if (t.key === "url") summary.url = t.value;
    else if (t.key === "environment") summary.environment = t.value;
    else if (t.key === "release") summary.release = t.value;
    else if (t.key === "browser") summary.browser = t.value;
    else if (t.key === "transaction") summary.transaction = t.value;
  }

  // Entries
  for (const entry of ev.entries || []) {
    if (entry.type === "exception") {
      for (const exc of entry.data?.values || []) {
        const frames: string[] = [];
        const appFrames = (exc.stacktrace?.frames || []).filter((f: { inApp?: boolean }) => f.inApp);
        for (const f of appFrames.slice(-10)) {
          let line = `${f.filename || "?"}:${f.lineNo || "?"} in ${f.function || "?"}`;
          // Include source context if available
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

/**
 * Get a single Sentry issue by ID.
 */
export async function getIssue(
  authToken: string,
  issueId: string,
): Promise<SentryIssue | null> {
  const res = await fetch(`https://sentry.io/api/0/issues/${issueId}/`, {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Sentry API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }

  return await res.json();
}
