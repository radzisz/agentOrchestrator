// ---------------------------------------------------------------------------
// BoundIssue — wraps TrackerIssue + BaseTracker + config + projectPath
// ---------------------------------------------------------------------------
export class BoundIssue {
    constructor(data, _tracker, _config, projectPath) {
        this.data = data;
        this._tracker = _tracker;
        this._config = _config;
        this.projectPath = projectPath;
    }
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
    async transitionTo(phase) {
        var _a, _b;
        if (!this._tracker.canTransitionState)
            return;
        await ((_b = (_a = this._tracker).transitionTo) === null || _b === void 0 ? void 0 : _b.call(_a, this._config, this.data, phase));
    }
    async addComment(body) {
        var _a, _b;
        if (!this._tracker.canComment)
            return;
        await ((_b = (_a = this._tracker).addComment) === null || _b === void 0 ? void 0 : _b.call(_a, this._config, this.data, body));
    }
    async getComments() {
        var _a, _b;
        if (!this._tracker.canDetectWake)
            return [];
        return await ((_b = (_a = this._tracker).getComments) === null || _b === void 0 ? void 0 : _b.call(_a, this._config, this.data)) || [];
    }
    hasLabel(label) {
        var _a, _b, _c;
        if (!this._tracker.canManageLabels)
            return false;
        return (_c = (_b = (_a = this._tracker).hasLabel) === null || _b === void 0 ? void 0 : _b.call(_a, this.data, label)) !== null && _c !== void 0 ? _c : false;
    }
    async reassignOnDone() {
        var _a, _b;
        await ((_b = (_a = this._tracker).reassignOnDone) === null || _b === void 0 ? void 0 : _b.call(_a, this._config, this.data));
    }
    async reload() {
        if (!this._tracker.getIssue)
            return null;
        const fresh = await this._tracker.getIssue(this._config, this.data.externalId);
        if (!fresh)
            return null;
        return new BoundIssue(fresh, this._tracker, this._config, this.projectPath);
    }
}
//# sourceMappingURL=bound-issue.js.map