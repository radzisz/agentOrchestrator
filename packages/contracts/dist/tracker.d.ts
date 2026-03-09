import type { ProviderTypeSchema } from "./config-schema";
export type TrackerPhase = "todo" | "in_progress" | "in_review" | "done" | "cancelled";
export interface TrackerIssue {
    externalId: string;
    identifier: string;
    title: string;
    description: string | null;
    priority: number;
    phase: TrackerPhase;
    rawState: string;
    labels: string[];
    createdBy: string | null;
    createdAt: string | null;
    url: string | null;
    source: string;
    comments: TrackerComment[];
    _raw: unknown;
}
export interface TrackerComment {
    body: string;
    createdAt: string;
    authorName: string;
    isBot: boolean;
}
export declare abstract class BaseTracker {
    abstract readonly name: string;
    abstract readonly schema: ProviderTypeSchema;
    readonly canTransitionState: boolean;
    readonly canComment: boolean;
    readonly canDetectWake: boolean;
    readonly canManageLabels: boolean;
    abstract pollIssues(config: Record<string, string>, projectPath: string): Promise<TrackerIssue[]>;
    transitionTo?(config: Record<string, string>, issue: TrackerIssue, phase: TrackerPhase): Promise<void>;
    addComment?(config: Record<string, string>, issue: TrackerIssue, body: string): Promise<void>;
    getComments?(config: Record<string, string>, issue: TrackerIssue): Promise<TrackerComment[]>;
    hasLabel?(issue: TrackerIssue, label: string): boolean;
    getIssue?(config: Record<string, string>, externalId: string): Promise<TrackerIssue | null>;
    reassignOnDone?(config: Record<string, string>, issue: TrackerIssue): Promise<void>;
    createIssue?(config: Record<string, string>, title: string, description: string, labels: string[]): Promise<{
        externalId: string;
        identifier: string;
    }>;
}
//# sourceMappingURL=tracker.d.ts.map