// ---------------------------------------------------------------------------
// Issue Tracker abstraction — types
// ---------------------------------------------------------------------------

export type TrackerPhase = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

export interface TrackerIssue {
  externalId: string;       // tracker-specific ID (Linear UUID, Sentry numeric ID)
  identifier: string;       // human-readable ("UKR-119", "SENTRY-ABC1")
  title: string;
  description: string | null;
  priority: number;         // 0=none, 1=urgent, 4=low
  phase: TrackerPhase;
  rawState: string;         // original state name
  labels: string[];
  createdBy: string | null;
  createdAt: string | null;
  url: string | null;
  source: string;           // "linear" | "sentry"
  comments: TrackerComment[];
  _raw: unknown;            // original tracker object
}

export interface TrackerComment {
  body: string;
  createdAt: string;
  authorName: string;
  isBot: boolean;
}

export interface TrackerConfigField {
  key: string;
  label: string;
  type: "string" | "secret" | "select" | "number" | "boolean";
  required?: boolean;
  description?: string;
  default?: string;
  options?: Array<{ label: string; value: string }>;
  projectOverride?: boolean;  // can this be overridden per-project?
  visibleWhen?: { field: string; value: string };  // conditional visibility
}

export interface TrackerTypeSchema {
  type: string;
  displayName: string;
  fields: TrackerConfigField[];
}

/**
 * Bound issue — wraps TrackerIssue + its tracker + projectPath
 * so callers don't need to pass tracker/projectPath everywhere.
 */
export class Issue {
  constructor(
    public readonly data: TrackerIssue,
    private readonly _tracker: IssueTracker,
    public readonly projectPath: string,
  ) {}

  // --- Delegate TrackerIssue fields ---
  get externalId() { return this.data.externalId; }
  get identifier() { return this.data.identifier; }
  get title() { return this.data.title; }
  get description() { return this.data.description; }
  get priority() { return this.data.priority; }
  get phase() { return this.data.phase; }
  get rawState() { return this.data.rawState; }
  get labels() { return this.data.labels; }
  get createdBy() { return this.data.createdBy; }
  get url() { return this.data.url; }
  get source() { return this.data.source; }

  // --- Capabilities ---
  get canTransitionState() { return this._tracker.canTransitionState; }
  get canComment() { return this._tracker.canComment; }
  get canDetectWake() { return this._tracker.canDetectWake; }
  get canManageLabels() { return this._tracker.canManageLabels; }

  // --- Operations ---
  async transitionTo(phase: TrackerPhase): Promise<void> {
    if (!this._tracker.canTransitionState) return;
    await this._tracker.transitionTo?.(this.data, phase, this.projectPath);
  }

  async addComment(body: string): Promise<void> {
    if (!this._tracker.canComment) return;
    await this._tracker.addComment?.(this.data, body, this.projectPath);
  }

  async getComments(): Promise<TrackerComment[]> {
    if (!this._tracker.canDetectWake) return [];
    return await this._tracker.getComments?.(this.data, this.projectPath) || [];
  }

  hasLabel(label: string): boolean {
    if (!this._tracker.canManageLabels) return false;
    return this._tracker.hasLabel?.(this.data, label) ?? false;
  }

  async reassignOnDone(): Promise<void> {
    await this._tracker.reassignOnDone?.(this.data, this.projectPath);
  }

  async reload(): Promise<Issue | null> {
    if (!this._tracker.getIssue) return null;
    const fresh = await this._tracker.getIssue(this.data.externalId, this.projectPath);
    if (!fresh) return null;
    return new Issue(fresh, this._tracker, this.projectPath);
  }
}

export interface IssueTracker {
  readonly name: string;
  readonly displayName: string;
  readonly schema: TrackerTypeSchema;

  // Required
  pollIssues(projectPath: string): Promise<TrackerIssue[]>;

  // Optional capabilities (check boolean before calling)
  readonly canTransitionState: boolean;
  transitionTo?(issue: TrackerIssue, phase: TrackerPhase, projectPath: string): Promise<void>;

  readonly canComment: boolean;
  addComment?(issue: TrackerIssue, body: string, projectPath: string): Promise<void>;

  readonly canDetectWake: boolean;
  getComments?(issue: TrackerIssue, projectPath: string): Promise<TrackerComment[]>;

  readonly canManageLabels: boolean;
  hasLabel?(issue: TrackerIssue, label: string): boolean;

  // Can this tracker create issues from the UI?
  readonly canCreateIssue?: boolean;

  // For fetching a single issue (used by manual spawn API)
  getIssue?(externalId: string, projectPath: string): Promise<TrackerIssue | null>;

  // Reassign issue to creator when agent finishes (assignee mode)
  reassignOnDone?(issue: TrackerIssue, projectPath: string): Promise<void>;

  // Create a new issue in the tracker
  createIssue?(title: string, description: string, labels: string[], projectPath: string): Promise<{ externalId: string; identifier: string }>;
}
