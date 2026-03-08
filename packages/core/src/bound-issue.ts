// ---------------------------------------------------------------------------
// BoundIssue — wraps TrackerIssue + BaseTracker + config + projectPath
// ---------------------------------------------------------------------------

import type {
  BaseTracker,
  TrackerIssue,
  TrackerComment,
  TrackerPhase,
} from "@orchestrator/contracts";

export class BoundIssue {
  constructor(
    public readonly data: TrackerIssue,
    private readonly _tracker: BaseTracker,
    private readonly _config: Record<string, string>,
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
    await this._tracker.transitionTo?.(this._config, this.data, phase);
  }

  async addComment(body: string): Promise<void> {
    if (!this._tracker.canComment) return;
    await this._tracker.addComment?.(this._config, this.data, body);
  }

  async getComments(): Promise<TrackerComment[]> {
    if (!this._tracker.canDetectWake) return [];
    return await this._tracker.getComments?.(this._config, this.data) || [];
  }

  hasLabel(label: string): boolean {
    if (!this._tracker.canManageLabels) return false;
    return this._tracker.hasLabel?.(this.data, label) ?? false;
  }

  async reassignOnDone(): Promise<void> {
    await this._tracker.reassignOnDone?.(this._config, this.data);
  }

  async reload(): Promise<BoundIssue | null> {
    if (!this._tracker.getIssue) return null;
    const fresh = await this._tracker.getIssue(this._config, this.data.externalId);
    if (!fresh) return null;
    return new BoundIssue(fresh, this._tracker, this._config, this.projectPath);
  }
}
