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
    metadata: {
        value?: string;
        message?: string;
    };
    project: {
        slug: string;
        name: string;
    };
    status: string;
    isUnhandled: boolean;
}
export declare function listIssues(authToken: string, org: string, projectSlug: string, since?: string): Promise<SentryIssue[]>;
export declare function updateIssueStatus(authToken: string, issueId: string, status: "resolved" | "ignored" | "unresolved"): Promise<void>;
export interface SentryProject {
    slug: string;
    name: string;
    id: string;
    platform: string | null;
}
export declare function listProjects(authToken: string, org: string): Promise<SentryProject[]>;
export declare function getProject(authToken: string, org: string, projectSlug: string): Promise<SentryProject | null>;
export interface SentryEventSummary {
    url?: string;
    environment?: string;
    release?: string;
    browser?: string;
    transaction?: string;
    exceptions: Array<{
        type: string;
        value: string;
        frames: string[];
    }>;
    breadcrumbs: string[];
}
export declare function getLatestEventSummary(authToken: string, org: string, issueId: string): Promise<SentryEventSummary | null>;
export declare function getIssue(authToken: string, issueId: string): Promise<SentryIssue | null>;
//# sourceMappingURL=sentry-api.d.ts.map