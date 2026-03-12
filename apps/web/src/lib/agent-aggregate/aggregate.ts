// ---------------------------------------------------------------------------
// AgentAggregate — unified state management for a single agent
// ---------------------------------------------------------------------------

import { existsSync } from "fs";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
import * as gitSvc from "@/services/git";
import { eventBus } from "@/lib/event-bus";
import type { TrackerIssue } from "@/lib/issue-trackers/types";
import type { AgentState, AggregateContext, CurrentOperation, ReadonlyAgentState } from "./types";
import { defaultAgentState, deriveUiStatus } from "./types";
import { deriveLegacyStatus, stateFromLegacy } from "./compat";

// Operations
import * as containerOps from "./operations/container";
import * as agentProcessOps from "./operations/agent-process";
import * as serviceOps from "./operations/services";
import * as gitOps from "./operations/git";

// Orchestration operations (user commands)
import * as spawnOps from "./operations/spawn";
import * as wakeStopOps from "./operations/wake-stop";
import * as removeOps from "./operations/remove";
import * as mergeRejectOps from "./operations/merge-reject";
import * as statusOps from "./operations/status";

export class AgentAggregate {
  readonly issueId: string;
  readonly projectPath: string;
  readonly projectName: string;

  private _agent: store.AgentData;
  private operationLock: Promise<void> = Promise.resolve();
  private _refreshPromise: Promise<void> | null = null;
  private _lastRefreshAt = 0;

  constructor(projectName: string, projectPath: string, agent: store.AgentData) {
    this.issueId = agent.issueId;
    this.projectPath = projectPath;
    this.projectName = projectName;
    this._agent = agent;

    // Bootstrap state if missing
    if (!this._agent.state) {
      this._agent.state = stateFromLegacy(agent);
      this._agent.currentOperation = null;
    }

    // Migrate: backfill trackerStatus from linearStatus for pre-migration agents
    if (!this._agent.state.trackerStatus) {
      this._agent.state.trackerStatus = this._agent.state.linearStatus || "unstarted";
    }

    // Clear stale git op if no operation is running
    if (!this._agent.currentOperation && this._agent.state.git.op !== "idle") {
      this._agent.state.git.op = "idle";
    }
  }

  // --- Read (public) ---

  /** Read-only snapshot of the current state. Deep cloned — safe for external use. */
  get snapshot(): ReadonlyAgentState {
    const s = this._state;
    return {
      agent: s.agent,
      container: s.container,
      lifecycle: s.lifecycle,
      transition: s.transition ? { ...s.transition } : null,
      trackerStatus: s.trackerStatus,
      linearStatus: s.linearStatus,
      git: { ...s.git, lastCommit: s.git.lastCommit ? { ...s.git.lastCommit } : null },
      services: JSON.parse(JSON.stringify(s.services)),
      lastError: s.lastError,
    };
  }

  /** Read-only view of agent metadata (deep clone — safe for external use). */
  get agentData(): Readonly<store.AgentData> {
    return JSON.parse(JSON.stringify(this._agent));
  }

  get currentOperation(): CurrentOperation | null {
    return this._agent.currentOperation ?? null;
  }

  get uiStatus() {
    return deriveUiStatus(this._state, this.currentOperation);
  }

  getLegacyStatus(): store.AgentStatus {
    return deriveLegacyStatus(this._state, this.currentOperation);
  }

  // --- Internal state access ---

  /** Mutable state — only for use within the aggregate and its operations. */
  private get _state(): AgentState {
    return this._agent.state!;
  }

  /** Build the onExit callback injected into agent process operations. */
  private _makeOnExitedCallback(): () => void {
    return () => this.reportProcessExited();
  }

  /**
   * Guarded lifecycle setter — enforces invariants at WRITE TIME.
   * lifecycle=removed is only allowed when trackerStatus is done/cancelled.
   * If tracker is still in_progress/unstarted, we auto-cancel it first.
   */
  private _setLifecycle(value: AgentState["lifecycle"]): void {
    if (value === "removed") {
      const ts = this._state.trackerStatus;
      if (ts === "in_progress" || ts === "unstarted") {
        this.opLog("lifecycle", `auto-cancelling tracker (was ${ts}) before setting lifecycle=removed`);
        this._state.trackerStatus = "cancelled";
        this._state.linearStatus = "cancelled";
      }
    }
    this._state.lifecycle = value;
  }

  /** Build the AggregateContext passed to extracted operation functions. */
  private _ctx(): AggregateContext {
    return {
      issueId: this.issueId,
      projectPath: this.projectPath,
      projectName: this.projectName,
      agent: this._agent,
      state: this._state,
      persist: () => this.persist(),
      opLog: (opName, msg) => this.opLog(opName, msg),
      makeOnExitedCallback: () => this._makeOnExitedCallback(),
      setLifecycle: (value) => this._setLifecycle(value),
      getDefaultBranch: () => this.getDefaultBranch(),
      beginTransition: (to) => {
        this._state.transition = { to, startedAt: new Date().toISOString() };
        this.persist();
      },
      endTransition: () => {
        this._state.transition = null;
        this.persist();
      },
    };
  }

  // --- Observation methods (external code reports what it observed) ---

  /** Report that the agent process has exited. */
  reportProcessExited(): void {
    if (this._state.agent === "running") {
      this._state.agent = "stopped";
      this.persist();
      eventBus.emit("agent:exited", { agentId: this.issueId, issueId: this.issueId });

      // Auto-push: agent committed, orchestrator pushes
      this._autoPush().catch((err) => {
        this.opLog("push", `auto-push failed: ${err}`);
      });
    }
  }

  /** Push agent branch to remote after agent exits. Works for clones and worktrees. */
  private async _autoPush(): Promise<void> {
    if (!this._agent.branch) return;
    try {
      const pushed = await gitOps.pushBranchToRemote(this._agent, this.projectPath);
      if (pushed) {
        this.opLog("push", `auto-pushed branch ${this._agent.branch}`);
      } else {
        this.opLog("push", `auto-push skipped: no remote available`);
      }
    } catch (err) {
      this.opLog("push", `auto-push failed: ${err}`);
    }
  }

  /** Report that the container is dead/missing. */
  reportContainerDead(): void {
    if (this._state.container !== "missing") {
      this._state.container = "missing";
    }
    if (this._state.agent === "running") {
      this._state.agent = "stopped";
    }
    this.persist();
  }

  /** Report that the agent's branch has been merged (e.g. externally via GitHub). */
  reportBranchMerged(): void {
    this._state.git.merged = true;
    if (this._state.trackerStatus !== "done" && this._state.trackerStatus !== "cancelled") {
      this._state.trackerStatus = "done";
      this._state.linearStatus = "done";
    }
    this._state.git.aheadBy = 0;
    this._state.git.behindBy = 0;
    this.persist();
  }

  /** Report that the remote branch is gone and agent is not running → done. */
  reportBranchGone(): void {
    if (this._state.agent !== "running") {
      this._state.trackerStatus = "done";
      this._state.linearStatus = "done";
      this._state.agent = "stopped";
      this.persist();
    }
  }

  /** Mark agent as previewed (agent posted "🤖 Gotowe"). */
  markPreviewed(): void {
    this._agent.previewed = true;
    this.persist();
  }

  /** Mark agent as notified (human approved). */
  markNotified(): void {
    this._agent.notified = true;
    this.persist();
  }

  /** Mark agent as reassigned (creator re-assigned after completion). */
  markReassigned(): void {
    this._agent.reassigned = true;
    this.persist();
  }

  /** Mark agent as errored — visible in UI. Lifecycle stays unchanged. */
  setError(message: string): void {
    this._state.lastError = message;
    this.persist();
    this.opLog("error", message);
  }

  /** Clear a stale currentOperation (server crash recovery). */
  clearStaleOperation(reason: string): void {
    this._agent.currentOperation = null;
    // Reset stuck git.op (e.g. "rebasing" left by server crash)
    if (this._state.git.op !== "idle") {
      this._state.git.op = "idle";
    }
    // Clear transition if stuck
    if (this._state.transition) {
      this._state.transition = null;
    }
    this.persist();
    this.opLog("lifecycle", `cleared stale operation: ${reason}`);
  }

  // --- User Commands (thin delegations) ---

  /** Queue a message for the agent without interrupting. */
  queueMessage(message: string): void {
    wakeStopOps.queueMessage(this._ctx(), message);
  }

  /** Spawn a new agent: clone → create container → start Claude process. */
  async spawnAgent(opts: {
    trackerIssue?: TrackerIssue;
    linearIssueUuid?: string;
    customPrompt?: string;
  }): Promise<void> {
    return this.withLock("spawn", (setProgress) =>
      spawnOps.spawnAgent(this._ctx(), opts, setProgress));
  }

  /** Set initial restore state synchronously so UI reflects immediately. */
  prepareRestore(): void {
    spawnOps.prepareRestore(this._ctx());
  }

  /** Restore a removed agent: re-clone from git, create container, launch Claude. */
  async restoreAgent(opts: { fromBranch: string; setInProgress?: boolean }): Promise<void> {
    return this.withLock("restore", (setProgress) =>
      spawnOps.restoreAgent(this._ctx(), opts, setProgress));
  }

  /** Set transition state immediately so the UI reflects "starting" before the async wake begins. */
  prepareWake(): void {
    this._state.transition = { to: "running", startedAt: new Date().toISOString() };
    this.persist();
  }

  /** Wake agent: ensure container alive → start Claude process. */
  async wakeAgent(message?: string, opts?: { reset?: boolean }): Promise<void> {
    return this.withLock("wake", (setProgress) =>
      wakeStopOps.wakeAgent(this._ctx(), setProgress, message, opts));
  }

  /** Stop Claude process (container stays alive).
   *  Bypasses the operation lock — stop must work even if another op is stuck. */
  async stopAgent(): Promise<void> {
    await wakeStopOps.stopAgent(this._ctx());
  }

  /** Remove agent: optionally close issue → stop → remove container → remove repo. */
  async removeAgent(opts?: { closeIssue?: boolean; deleteBranch?: boolean }): Promise<void> {
    return this.withLock("remove", (setProgress) =>
      removeOps.removeAgent(this._ctx(), setProgress, opts));
  }

  /** Rebase agent branch onto default branch.
   *  @param opts.wakeOnConflict — if true, wake the agent to resolve conflicts (default: false for auto-rebase) */
  async rebase(opts?: { wakeOnConflict?: boolean }): Promise<{ success: boolean; steps: any[]; error?: string; conflict?: boolean; conflictFiles?: string[] }> {
    let result: any;
    await this.withLock("rebase", async (setProgress) => {
      result = await mergeRejectOps.rebase(this._ctx(), setProgress);

      // If conflict and caller requested wake, start agent to resolve
      if (result.conflict && result.conflictFiles && opts?.wakeOnConflict) {
        const conflictMsg = [
          "## URGENT: Rebase required — conflicts must be resolved",
          "",
          "An automatic rebase onto the default branch was attempted but **failed due to merge conflicts**.",
          "The rebase was **aborted** — your working tree is clean but your branch is BEHIND the default branch.",
          "",
          `Conflicting file(s): ${result.conflictFiles.map((f: string) => `\`${f}\``).join(", ")}`,
          "",
          "**You MUST do the following steps (do NOT skip any):**",
          "",
          "1. Run `git fetch origin` to get latest changes",
          "2. Run `git rebase origin/main` — this will show conflicts",
          "3. Open the conflicting files, resolve ALL conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)",
          "4. Run `git add .` then `git rebase --continue`",
          "5. Run `git push --force-with-lease origin HEAD`",
          "",
          "**IMPORTANT:** Do NOT just check if the tree is clean — it IS clean because the rebase was aborted.",
          "You MUST run `git rebase origin/main` again to start the rebase and resolve the actual conflicts.",
          "Verify with `git rev-list --count HEAD..origin/main` — if this number is > 0, the rebase is NOT done.",
        ].join("\n");

        this.wakeAgent(conflictMsg).catch(e => cmd.logError(`rebase:${this.issueId}`, `wake failed: ${e}`));
      }
    });
    return result;
  }

  /** Merge agent branch and close Linear issue. */
  async mergeAndClose(opts?: { toggle?: boolean; enableToggle?: boolean; closeIssue?: boolean; cleanup?: boolean; skipMerge?: boolean }): Promise<{ success: boolean; commits: string; diffStats: string }> {
    let mergeResult: { commits: string; diffStats: string } = { commits: "", diffStats: "" };
    await this.withLock("mergeAndClose", async (setProgress) => {
      mergeResult = await mergeRejectOps.mergeAndClose(this._ctx(), setProgress, opts);
    });
    return { success: true, ...mergeResult };
  }

  /** Reject agent: cancel Linear issue. */
  async reject(closeIssue = true): Promise<void> {
    return this.withLock("reject", () =>
      mergeRejectOps.reject(this._ctx(), closeIssue));
  }

  /** Get full status. */
  async getStatus() {
    return statusOps.getStatus(this._ctx(), this.currentOperation);
  }

  /** Get merge info (commits + diff stats). */
  async getMergeInfo(): Promise<{ commits: string; diffStats: string }> {
    return statusOps.getMergeInfo(this._ctx());
  }

  /** Start preview services (host mode). */
  async startServices(opts?: { mode?: "container" | "host" }): Promise<void> {
    return this.withLock("startServices", async (setProgress) => {
      setProgress("starting services");
      await serviceOps.startAllServices(this._agent, this.projectName, this.projectPath, this._state, { mode: "host", ...opts });
      this.persist();
    });
  }

  /** Stop preview services. */
  async stopServices(): Promise<void> {
    return this.withLock("stopServices", async () => {
      await serviceOps.stopAllServices(this._agent, this.projectName, this.projectPath, this._state);
      this.persist();
    });
  }

  // --- Refresh ---

  /** Refresh all state axes by checking actual system state. */
  async refreshAgent(opts?: { force?: boolean }): Promise<void> {
    // Skip refresh while an operation is running — checking git/container
    // during merge/rebase/spawn causes lock contention and freezes the event loop
    if (this._agent.currentOperation && !opts?.force) return;
    const now = Date.now();
    if (!opts?.force && now - this._lastRefreshAt < 10_000) return;
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = this._doRefresh();
    try {
      await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
      this._lastRefreshAt = Date.now();
    }
  }

  private async _doRefresh(): Promise<void> {
    const wasPreviouslyRunning = this._state.agent === "running";

    // Container check must come first — agent process depends on it
    this._state.container = await containerOps.checkContainer(this._agent);
    // Agent process, services, and git are independent — run in parallel
    const [agent, services, git] = await Promise.all([
      agentProcessOps.checkAgentProcess(this._agent, this._state.container, this.projectPath, this._makeOnExitedCallback()),
      serviceOps.checkServices(this._agent, this.projectPath),
      gitOps.checkGit(this._agent, this._state.git, this.projectPath),
    ]);
    this._state.agent = agent;
    this._state.services = services;
    this._state.git = git;

    if (wasPreviouslyRunning && this._state.agent === "stopped") {
      await this.recoverAgentOutput();
    }

    if (this._state.git.merged && this._state.trackerStatus !== "done" && this._state.trackerStatus !== "cancelled") {
      this._state.trackerStatus = "done";
      this._state.linearStatus = "done";
    }

    if (this._state.agent === "running" && this._state.container !== "running") {
      this._state.agent = "stopped";
      this.opLog("lifecycle", `forced agent=stopped: container=${this._state.container}`);
    }

    if (this._state.lifecycle === "removed" && this._state.container !== "missing") {
      this.opLog("lifecycle", `orphan container detected: lifecycle=removed but container=${this._state.container}, cleaning up`);
      containerOps.removeContainerAndVolume(this._agent, this._state).catch(() => {});
    }

    // Clear stale transitions — if agent reached target state or transition is stuck > 5 min
    if (this._state.transition) {
      const reached = (this._state.transition.to === "running" && this._state.agent === "running") ||
                      (this._state.transition.to === "stopped" && this._state.agent === "stopped");
      const stale = Date.now() - new Date(this._state.transition.startedAt).getTime() > 300_000;
      if (reached || stale) {
        if (stale && !reached) {
          this.opLog("lifecycle", `cleared stale transition: to=${this._state.transition.to} started=${this._state.transition.startedAt}`);
        }
        this._state.transition = null;
      }
    }

    if (this._state.lifecycle === "active" &&
        (this._state.trackerStatus === "done" || this._state.trackerStatus === "cancelled") &&
        this._state.container === "missing" &&
        this._state.agent === "stopped" &&
        (!this._agent.agentDir || !existsSync(this._agent.agentDir))) {
      this._state.lifecycle = "removed";
      this.opLog("lifecycle", "derived lifecycle=removed: tracker closed, no container, no files");
    }

    this.persist();
  }

  /** Recover agent output from in-memory live buffer (best-effort after server restart). */
  private async recoverAgentOutput(): Promise<void> {
    try {
      const output = agentProcessOps.getLiveOutput(this.issueId, 50);
      if (!output) return;

      const filtered = agentProcessOps.filterClaudeOutput(output);
      if (!filtered) return;

      const prefix = filtered.slice(0, 80);
      const messages = store.getMessages(this.projectPath, this.issueId);
      // Check all recent agent messages for duplicates (onExit may have already saved it)
      const recentAgentMsgs = messages.filter(m => m.role === "agent").slice(-3);
      if (recentAgentMsgs.some(m => m.text.startsWith(prefix) || filtered.startsWith(m.text.slice(0, 80)))) return;

      store.appendMessage(this.projectPath, this.issueId, "agent", filtered);
      this.opLog("lifecycle", "recovered agent output from live buffer");
    } catch {
      // best effort
    }
  }

  // --- Internal ---

  private async getDefaultBranch(): Promise<string> {
    return gitSvc.getDefaultBranch(this.projectPath);
  }

  private persist(): void {
    store.saveAgent(this.projectPath, this.issueId, this._agent);
  }

  private opLog(opName: string, msg: string): void {
    store.appendLog(this.projectPath, `agent-${this.issueId}-${opName}`, msg);
  }

  // Timeouts per operation type (ms).
  private static readonly OP_TIMEOUTS: Record<string, number> = {
    mergeAndClose: 600_000,
    remove: 300_000,
    spawn: 300_000,
    restore: 300_000,
    rebase: 300_000,
  };
  private static readonly DEFAULT_TIMEOUT_MS = 120_000;

  private async withLock(
    opName: string,
    fn: (setProgress: (msg: string) => void) => Promise<void>,
  ): Promise<void> {
    const execute = async () => {
      this._agent.currentOperation = {
        name: opName,
        startedAt: new Date().toISOString(),
      };
      this.persist();
      this.opLog(opName, "started");

      const setProgress = (msg: string) => {
        if (this._agent.currentOperation) {
          this._agent.currentOperation.progress = msg;
        }
        this.persist();
        this.opLog(opName, msg);
      };

      const timeoutMs = AgentAggregate.OP_TIMEOUTS[opName] ?? AgentAggregate.DEFAULT_TIMEOUT_MS;

      let timedOut = false;
      const warnTimer = setTimeout(() => {
        timedOut = true;
        this.opLog(opName, `WARNING: operation running longer than ${timeoutMs / 1000}s`);
      }, timeoutMs);

      try {
        await fn(setProgress);
        this.opLog(opName, timedOut ? `${opName} finished (after timeout warning)` : `${opName} finished`);
      } catch (err) {
        this.opLog(opName, `error: ${sanitizeError(err)}`);
        throw err;
      } finally {
        clearTimeout(warnTimer);
        this._agent.currentOperation = null;
        this.persist();
      }
    };

    this.operationLock = this.operationLock.then(execute, execute);
    return this.operationLock;
  }

  /** Reload agent data from store (in case disk was updated externally). */
  reload(): void {
    const fresh = store.getAgentRef(this.projectPath, this.issueId);
    if (fresh) {
      this._agent = fresh;
    }
    if (!this._agent.state) {
      this._agent.state = stateFromLegacy(this._agent);
      this._agent.currentOperation = null;
    }
    if (!this._agent.currentOperation && this._agent.state.git.op !== "idle") {
      this._agent.state.git.op = "idle";
    }
  }
}

function sanitizeError(err: unknown): string {
  return String(err).replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}
