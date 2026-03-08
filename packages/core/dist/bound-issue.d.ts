import type { BaseTracker, TrackerIssue, TrackerComment, TrackerPhase } from "@orchestrator/contracts";
export declare class BoundIssue {
    readonly data: TrackerIssue;
    private readonly _tracker;
    private readonly _config;
    readonly projectPath: string;
    constructor(data: TrackerIssue, _tracker: BaseTracker, _config: Record<string, string>, projectPath: string);
    get externalId(): string;
    get identifier(): string;
    get title(): string;
    get description(): string | null;
    get priority(): number;
    get phase(): TrackerPhase;
    get rawState(): string;
    get labels(): string[];
    get createdBy(): string | null;
    get url(): string | null;
    get source(): string;
    get canTransitionState(): boolean;
    get canComment(): boolean;
    get canDetectWake(): boolean;
    get canManageLabels(): boolean;
    transitionTo(phase: TrackerPhase): Promise<void>;
    addComment(body: string): Promise<void>;
    getComments(): Promise<TrackerComment[]>;
    hasLabel(label: string): boolean;
    reassignOnDone(): Promise<void>;
    reload(): Promise<BoundIssue | null>;
}
//# sourceMappingURL=bound-issue.d.ts.map