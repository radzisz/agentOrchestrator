// ---------------------------------------------------------------------------
// Tracker contract — abstract base class for issue trackers
// ---------------------------------------------------------------------------
export class BaseTracker {
    constructor() {
        this.canTransitionState = false;
        this.canComment = false;
        this.canDetectWake = false;
        this.canManageLabels = false;
    }
}
//# sourceMappingURL=tracker.js.map