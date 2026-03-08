import { BaseTracker, type TrackerIssue, type TrackerComment, type TrackerPhase, type ProviderTypeSchema } from "@orchestrator/contracts";
export declare const linearSchema: ProviderTypeSchema;
export declare class LinearTracker extends BaseTracker {
    readonly name = "linear";
    readonly schema: ProviderTypeSchema;
    readonly canTransitionState = true;
    readonly canComment = true;
    readonly canDetectWake = true;
    readonly canManageLabels = true;
    /**
     * Optional callback: invoked when team ID is resolved from teamKey,
     * so the host can persist it back to the instance config.
     */
    onTeamResolved?: (config: Record<string, string>, teamId: string) => void;
    pollIssues(config: Record<string, string>): Promise<TrackerIssue[]>;
    transitionTo(config: Record<string, string>, issue: TrackerIssue, phase: TrackerPhase): Promise<void>;
    addComment(config: Record<string, string>, issue: TrackerIssue, body: string): Promise<void>;
    getComments(_config: Record<string, string>, issue: TrackerIssue): Promise<TrackerComment[]>;
    hasLabel(issue: TrackerIssue, label: string): boolean;
    reassignOnDone(config: Record<string, string>, issue: TrackerIssue): Promise<void>;
    getIssue(config: Record<string, string>, externalId: string): Promise<TrackerIssue | null>;
}
//# sourceMappingURL=tracker.d.ts.map