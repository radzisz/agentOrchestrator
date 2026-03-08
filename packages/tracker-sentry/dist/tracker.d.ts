import { BaseTracker, type TrackerIssue, type TrackerPhase, type ProviderTypeSchema } from "@orchestrator/contracts";
export declare function buildSentryIdentifier(shortId: string, projectSlug: string, projectShortNamesRaw?: string): string;
export declare const sentrySchema: ProviderTypeSchema;
export declare class SentryTracker extends BaseTracker {
    readonly name = "sentry";
    readonly schema: ProviderTypeSchema;
    readonly canTransitionState = true;
    pollIssues(config: Record<string, string>): Promise<TrackerIssue[]>;
    transitionTo(config: Record<string, string>, issue: TrackerIssue, phase: TrackerPhase): Promise<void>;
    getIssue(config: Record<string, string>, externalId: string): Promise<TrackerIssue | null>;
}
//# sourceMappingURL=tracker.d.ts.map