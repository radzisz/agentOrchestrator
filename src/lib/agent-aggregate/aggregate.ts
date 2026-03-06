// ---------------------------------------------------------------------------
// AgentAggregate — unified state management for a single agent
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";
import { simpleGit } from "@/lib/cmd";
import * as portManager from "@/services/port-manager";
import * as linear from "@/services/linear";
import { eventBus } from "@/lib/event-bus";
import {
  getContainerStatus,
  isProcessRunning,
} from "@/lib/docker";
import type { AgentState, CurrentOperation } from "./types";
import { defaultAgentState, deriveUiStatus } from "./types";
import { deriveLegacyStatus, stateFromLegacy } from "./compat";

// Operations
import * as containerOps from "./operations/container";
import * as agentProcessOps from "./operations/agent-process";
import * as serviceOps from "./operations/services";
import * as gitOps from "./operations/git";
import * as linearOps from "./operations/linear";

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

    // Recover from stale in-memory state by reloading from disk
    this.healState();
  }

  // --- Read ---

  get state(): AgentState {
    return this._agent.state!;
  }

  get currentOperation(): CurrentOperation | null {
    return this._agent.currentOperation ?? null;
  }

  get agent(): store.AgentData {
    return this._agent;
  }

  get uiStatus() {
    return deriveUiStatus(this.state, this.currentOperation);
  }

  getLegacyStatus(): store.AgentStatus {
    return deriveLegacyStatus(this.state, this.currentOperation);
  }

  // --- User Commands ---

  /** Queue a message for the agent without interrupting. Appends to TASK.md + chat history. */
  queueMessage(message: string): void {
    if (!this._agent.agentDir) return;

    const tenxDir = join(this._agent.agentDir, ".10timesdev");
    if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });
    const taskMdPath = join(tenxDir, "TASK.md");

    if (existsSync(taskMdPath)) {
      appendFileSync(taskMdPath, `\n\n## New instructions from human\n\n${message}\n`);
    }

    store.appendMessage(this.projectPath, this.issueId, "human", message);
    this.opLog("lifecycle", `message queued (agent running): ${message.slice(0, 100)}`);
  }

  /** Spawn a new agent: clone → create container → start Claude process. */
  async spawnAgent(opts: {
    linearIssueUuid: string;
    customPrompt?: string;
  }): Promise<void> {
    return this.withLock("spawn", async (setProgress) => {
      const cfg = store.getProjectConfig(this.projectPath);
      const agentDir = join(this.projectPath, ".10timesdev", "agents", this.issueId);

      // Fetch issue from Linear
      setProgress("fetching Linear issue");
      const issue = await linear.getIssue(cfg.LINEAR_API_KEY, opts.linearIssueUuid);
      if (!issue) throw new Error(`Issue ${this.issueId} not found in Linear`);

      // Update agent record
      this._agent.title = issue.title;
      this._agent.description = issue.description || undefined;
      this._agent.linearIssueUuid = issue.id;
      this._agent.branch = `agent/${this.issueId}`;
      this._agent.agentDir = agentDir;
      this.state.lifecycle = "spawning";
      this.state.linearStatus = "in_progress";

      // Allocate port
      const ports = portManager.allocate(this.projectName, this.issueId);
      this._agent.portSlot = ports.slot;
      this._agent.containerName = `agent-${this.issueId}`;

      store.cacheAgent(this.projectPath, this.issueId, this._agent);

      try {
        // Clone repo
        setProgress("cloning repository");
        await gitOps.cloneRepo(this._agent, this.projectPath, issue, this.state);
        this.persist();

        // Copy .env if exists
        const envFile = join(this.projectPath, ".env");
        if (existsSync(envFile)) {
          writeFileSync(join(agentDir, ".env"), readFileSync(envFile));
        }

        // Install dependencies
        setProgress("installing dependencies");
        if (existsSync(join(agentDir, "pnpm-lock.yaml"))) {
          await cmd.run("pnpm install --frozen-lockfile", { cwd: agentDir, source: "agent-aggregate", timeout: 120000 });
        } else if (existsSync(join(agentDir, "package-lock.json"))) {
          await cmd.run("npm ci", { cwd: agentDir, source: "agent-aggregate", timeout: 120000 });
        }

        // Ensure orchestrator files are git-ignored
        this.ensureGitIgnored(agentDir, [".10timesdev", "agent-output.log", ".agent-container", "messages.jsonl"]);

        // Migrate legacy orchestrator files
        const tenxDir = join(agentDir, ".10timesdev");
        if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });

        // Write TASK.md and CLAUDE.md
        setProgress("writing task files");
        this.writeTaskMd(agentDir, issue);
        this.writeClaudeMd(agentDir, ports);

        // Log initial message
        const initialMessage = opts.customPrompt || `${issue.identifier}: ${issue.title}\n\n${issue.description || ""}`;
        store.appendMessage(this.projectPath, this.issueId, "human", initialMessage);

        // Comment on Linear
        await linear.addComment(
          cfg.LINEAR_API_KEY,
          issue.id,
          `🤖 Agent started\n\nProject: ${this.projectName}\nSlot: ${ports.slot} (ports: ${ports.frontend[0]}, ${ports.backend[0]}...)\nBranch: agent/${this.issueId}`,
        );

        // Create container
        setProgress("creating Docker container");
        await containerOps.createContainer(this._agent, this.projectPath, this.state);

        // Launch Claude
        setProgress("launching Claude");
        const prompt = opts.customPrompt ||
          "Read .10timesdev/TASK.md — this is your task from Linear. Read .10timesdev/CLAUDE.md — it contains your ports, identity, and rules. Complete the task. When done, comment on Linear as instructed in CLAUDE_GLOBAL.md.";
        await agentProcessOps.startAgentProcess(this._agent, this.projectPath, this.state, prompt);

        this.state.lifecycle = "active";
        this._agent.spawned = true;
        this.persist();

        this.opLog("spawn", `container=agent-${this.issueId} branch=agent/${this.issueId} slot=${ports.slot}`);
        eventBus.emit("agent:spawned", {
          agentId: this.issueId,
          issueId: this.issueId,
          projectName: this.projectName,
          containerName: `agent-${this.issueId}`,
          branch: `agent/${this.issueId}`,
        });
      } catch (error) {
        const safeMsg = sanitizeError(error);
        this.state.agent = "stopped";
        this.state.lifecycle = "active";
        this.persist();
        this.opLog("spawn", `error: ${safeMsg}`);
        eventBus.emit("agent:error", { agentId: this.issueId, issueId: this.issueId, error: safeMsg });
        throw new Error(safeMsg);
      }
    });
  }

  /** Wake agent: ensure container alive → start Claude process. */
  async wakeAgent(message?: string, opts?: { reset?: boolean }): Promise<void> {
    return this.withLock("wake", async (setProgress) => {
      const TERMINAL = new Set(["removed"]);
      if (TERMINAL.has(this.state.lifecycle)) {
        throw new Error(`Agent ${this.issueId} is in terminal state: ${this.state.lifecycle}`);
      }
      if (this.state.linearStatus === "done" || this.state.linearStatus === "cancelled") {
        throw new Error(`Agent ${this.issueId} is in terminal linear status: ${this.state.linearStatus}`);
      }

      if (!this._agent.agentDir || !this._agent.containerName) {
        throw new Error("Agent has no directory or container");
      }

      const tenxDir = join(this._agent.agentDir, ".10timesdev");
      if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });
      const taskMdPath = join(tenxDir, "TASK.md");

      if (!existsSync(taskMdPath)) {
        writeFileSync(taskMdPath, `# ${this._agent.issueId}: ${this._agent.title || "Task"}\n\n${this._agent.description || ""}\n`, "utf-8");
      }

      if (opts?.reset) {
        const content = readFileSync(taskMdPath, "utf-8");
        const cleaned = content.replace(/\n\n## New instructions from human\n\n[\s\S]*$/m, "");
        writeFileSync(taskMdPath, cleaned, "utf-8");
      }

      if (message) {
        appendFileSync(taskMdPath, `\n\n## New instructions from human\n\n${message}\n`);
        store.appendMessage(this.projectPath, this.issueId, "human", message);
      }

      // Ensure container alive
      setProgress("checking container");
      await containerOps.ensureContainerRunning(this._agent, this.projectPath, this.state);

      // Launch Claude
      setProgress("launching Claude");
      const prompt = message
        ? "Read .10timesdev/TASK.md — at the end of the file there are NEW INSTRUCTIONS from human. Read .10timesdev/CLAUDE.md. Apply the changes according to the new instructions. When done, comment on Linear."
        : "Read .10timesdev/TASK.md and .10timesdev/CLAUDE.md. Continue working. When done, comment on Linear.";
      await agentProcessOps.startAgentProcess(this._agent, this.projectPath, this.state, prompt);

      this.persist();
      this.opLog("wake", `message=${(message || "resumed").slice(0, 100)}`);
      eventBus.emit("agent:wake", { agentId: this.issueId, issueId: this.issueId, message: message || "resumed" });
    });
  }

  /** Stop Claude process (container stays alive). */
  async stopAgent(): Promise<void> {
    return this.withLock("stop", async () => {
      await agentProcessOps.stopAgentProcess(this._agent, this.state);
      // Also stop preview services — they consume significant CPU
      await serviceOps.stopAllServices(this._agent, this.projectName, this.projectPath, this.state).catch(() => {});
      this._agent.servicesEnabled = false;
      this.persist();
      this.opLog("stop", "claude + services killed, container alive");
      eventBus.emit("agent:stopped", { agentId: this.issueId, issueId: this.issueId });
    });
  }

  /** Remove agent: optionally close Linear → stop → stop services → remove container → remove repo. */
  async removeAgent(opts?: { closeIssue?: boolean }): Promise<void> {
    return this.withLock("remove", async (setProgress) => {
      // Close Linear FIRST (before destroying anything)
      if (opts?.closeIssue) {
        setProgress("closing Linear issue");
        try {
          await linearOps.cancelLinearIssue(this._agent, this.projectPath, this.state);
        } catch (err) {
          this.opLog("remove", `Linear close failed (continuing): ${err}`);
        }
      }

      this.state.lifecycle = "removed";
      this.persist();
      eventBus.emit("agent:cleanup", { agentId: this.issueId, issueId: this.issueId });

      setProgress("stopping services");
      await serviceOps.stopAllServices(this._agent, this.projectName, this.projectPath, this.state).catch(() => {});

      setProgress("removing container");
      await containerOps.removeContainerAndVolume(this._agent, this.state).catch(() => {});

      setProgress("removing repository");
      await gitOps.deleteRemoteBranch(this._agent, this.projectPath).catch(() => {});
      await gitOps.removeRepo(this._agent).catch(() => {});

      this.persist();
      this.opLog("remove", "cleanup complete");
    });
  }

  /** Refresh all state axes by checking actual system state.
   *  Silent — does NOT set currentOperation (internal housekeeping, not user-facing).
   *  Debounced: concurrent callers share the same promise; won't run more than once per 10s. */
  async refreshAgent(): Promise<void> {
    // Debounce: skip if last refresh was <10s ago
    const now = Date.now();
    if (now - this._lastRefreshAt < 10_000) return;

    // Coalesce: if already running, return existing promise
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
    const wasPreviouslyRunning = this.state.agent === "running";
    await containerOps.checkContainer(this._agent, this.state);
    await agentProcessOps.checkAgentProcess(this._agent, this.state, this.projectPath);
    await serviceOps.checkServices(this._agent, this.projectPath, this.state);
    await gitOps.checkGit(this._agent, this.state, this.projectPath);

    // Recover unsaved agent output after server restart:
    // If agent was "running" (stale state) but is now stopped, collect output from container
    if (wasPreviouslyRunning && this.state.agent === "stopped") {
      await this.recoverAgentOutput();
    }

    // If branch is merged but Linear still shows in_progress → mark as done
    if (this.state.git.merged && this.state.linearStatus === "in_progress") {
      this.state.linearStatus = "done";
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

      // Avoid duplicates: check if last message already has this content
      const messages = store.getMessages(this.projectPath, this.issueId);
      const lastAgent = [...messages].reverse().find(m => m.role === "agent");
      if (lastAgent && filtered.startsWith(lastAgent.text.slice(0, 50))) return;

      store.appendMessage(this.projectPath, this.issueId, "agent", filtered);
      this.opLog("lifecycle", "recovered agent output from live buffer");
    } catch {
      // best effort
    }
  }

  /** Start preview services. */
  async startServices(opts?: { mode?: "container" | "host" }): Promise<void> {
    return this.withLock("startServices", async (setProgress) => {
      if (opts?.mode !== "host") {
        setProgress("ensuring container");
        await containerOps.ensureContainerRunning(this._agent, this.projectPath, this.state);
      }
      setProgress("starting services");
      await serviceOps.startAllServices(this._agent, this.projectName, this.projectPath, this.state, opts);
      this.persist();
    });
  }

  /** Stop preview services. */
  async stopServices(): Promise<void> {
    return this.withLock("stopServices", async () => {
      await serviceOps.stopAllServices(this._agent, this.projectName, this.projectPath, this.state);
      this.persist();
    });
  }

  /** Rebase agent branch onto default branch. */
  async rebase(): Promise<{ success: boolean; steps: any[]; error?: string; conflict?: boolean; conflictFiles?: string[] }> {
    let result: any;
    await this.withLock("rebase", async (setProgress) => {
      this._agent.rebaseResult = undefined;
      this.state.git.op = "rebasing";
      this.persist();

      result = await gitOps.rebaseRepo(this._agent, this.projectPath, this.state, setProgress);
      this._agent.rebaseResult = result;

      // If conflict, wake the agent with conflict message
      if (result.conflict && result.conflictFiles) {
        const conflictMsg = [
          "## Rebase conflicts detected",
          "",
          `Rebase failed with conflicts in ${result.conflictFiles.length} file(s):`,
          ...result.conflictFiles.map((f: string) => `- \`${f}\``),
          "",
          "1. Resolve conflicts manually",
          "2. `git add .` then `git rebase --continue`",
          "3. `git push --force-with-lease`",
        ].join("\n");

        // Wake in background
        this.wakeAgent(conflictMsg).catch(e => cmd.logError(`rebase:${this.issueId}`, `wake failed: ${e}`));
      }

      this.opLog("rebase", `result: success=${result.success}`);
      this.persist();
    });
    return result;
  }

  /** Merge agent branch and close Linear issue. */
  async mergeAndClose(opts?: { toggle?: boolean; enableToggle?: boolean; closeIssue?: boolean; cleanup?: boolean; skipMerge?: boolean }): Promise<{ success: boolean; commits: string; diffStats: string }> {
    let mergeResult: { commits: string; diffStats: string } = { commits: "", diffStats: "" };
    await this.withLock("mergeAndClose", async (setProgress) => {
      const closeIssue = opts?.closeIssue ?? true;

      if (!opts?.skipMerge) {
        setProgress("fetching and merging");
        mergeResult = await gitOps.mergeRepo(this._agent, this.projectPath, this.state);
      } else {
        this.opLog("mergeAndClose", "skipping merge (branch already merged)");
      }

      // Build toggle message
      let toggleMsg = "";
      if (opts?.toggle) {
        const toggleName = this.issueId.toLowerCase().replace("-", "_");
        toggleMsg = opts.enableToggle
          ? ` z toggle **${toggleName}** = ON`
          : ` z toggle **${toggleName}** = OFF (kod w produkcji, ficzer nieaktywny)`;
      }

      const cfg = store.getProjectConfig(this.projectPath);
      const git = simpleGit(this.projectPath);
      let defaultBranch = "main";
      try {
        const ref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
        defaultBranch = ref.trim().replace("refs/remotes/origin/", "");
      } catch {}

      // Close Linear issue
      if (closeIssue) {
        setProgress("closing Linear issue");
        await linearOps.closeLinearIssue(
          this._agent,
          this.projectPath,
          this.state,
          `✅ Merged to ${defaultBranch}${toggleMsg}`,
        );
      } else if (this._agent.linearIssueUuid && cfg.LINEAR_API_KEY) {
        await linear.addComment(cfg.LINEAR_API_KEY, this._agent.linearIssueUuid, `✅ Merged to ${defaultBranch}${toggleMsg}`);
      }

      this.state.linearStatus = closeIssue ? "done" : this.state.linearStatus;
      this.persist();

      this.opLog("mergeAndClose", `merged commits=${mergeResult.commits}`);
      eventBus.emit("agent:merged", { agentId: this.issueId, issueId: this.issueId, branch: this._agent.branch || "" });

      // Inline cleanup (cannot call this.removeAgent() — it would deadlock on withLock)
      if (opts?.cleanup) {
        this.state.lifecycle = "removed";
        this.persist();
        eventBus.emit("agent:cleanup", { agentId: this.issueId, issueId: this.issueId });

        setProgress("stopping services");
        await serviceOps.stopAllServices(this._agent, this.projectName, this.projectPath, this.state).catch(() => {});

        setProgress("removing container");
        await containerOps.removeContainerAndVolume(this._agent, this.state).catch(() => {});

        setProgress("removing repository");
        await gitOps.deleteRemoteBranch(this._agent, this.projectPath).catch(() => {});
        await gitOps.removeRepo(this._agent).catch(() => {});

        this.persist();
        this.opLog("mergeAndClose", "cleanup complete");
      }
    });
    return { success: true, ...mergeResult };
  }

  /** Reject agent: cancel Linear issue. */
  async reject(closeIssue = true): Promise<void> {
    return this.withLock("reject", async () => {
      const cfg = store.getProjectConfig(this.projectPath);
      if (this._agent.linearIssueUuid && cfg.LINEAR_API_KEY) {
        // Always comment
        await linear.addComment(cfg.LINEAR_API_KEY, this._agent.linearIssueUuid, "❌ Odrzucone — nie mergowane");
        // Only change Linear state if closeIssue
        if (closeIssue) {
          await linearOps.cancelLinearIssue(this._agent, this.projectPath, this.state);
        }
      }
      this.state.linearStatus = closeIssue ? "cancelled" : "in_progress";
      this.persist();
      this.opLog("reject", `rejected closeIssue=${closeIssue}`);
    });
  }

  /** Get full status (equivalent to agent-lifecycle.getStatus).
   *  Uses CLI-based docker calls — never blocks event loop. */
  async getStatus() {
    let containerStatus = null;
    if (this._agent.containerName) {
      containerStatus = await getContainerStatus(this._agent.containerName);
    }
    let claudeRunning = false;
    if (this._agent.containerName && containerStatus?.status === "running") {
      claudeRunning = await isProcessRunning(this._agent.containerName, "claude.*--dangerously-skip-permissions");
    }
    return {
      agent: this._agent,
      containerStatus,
      projectName: this.projectName,
      claudeRunning,
      state: this.state,
      currentOperation: this.currentOperation,
      uiStatus: deriveUiStatus(this.state, this.currentOperation),
    };
  }

  /** Get merge info (commits + diff stats). */
  async getMergeInfo(): Promise<{ commits: string; diffStats: string }> {
    const git = simpleGit(this.projectPath);
    const branchName = this._agent.branch || `agent/${this.issueId}`;
    let defaultBranch = "main";
    try {
      const ref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      defaultBranch = ref.trim().replace("refs/remotes/origin/", "");
    } catch {
      try { await git.raw(["rev-parse", "--verify", "origin/main"]); } catch { defaultBranch = "master"; }
    }

    await git.fetch("origin", branchName);
    const logResult = await git.log({ from: defaultBranch, to: `origin/${branchName}`, "--oneline": null });
    const commits = logResult.all.map(c => `${c.hash.slice(0, 7)} ${c.message}`).join("\n");
    const diffStats = (await git.diff(["--stat", `${defaultBranch}..origin/${branchName}`])).trim();

    return { commits, diffStats };
  }

  // --- Internal ---

  private persist(): void {
    store.saveAgent(this.projectPath, this.issueId, this._agent);
  }

  /** Log to per-operation file: agent-{issueId}-{opName}.log */
  private opLog(opName: string, msg: string): void {
    store.appendLog(this.projectPath, `agent-${this.issueId}-${opName}`, msg);
  }

  // Timeouts per operation type (ms). Operations with cleanup need more time.
  private static readonly OP_TIMEOUTS: Record<string, number> = {
    mergeAndClose: 600_000,  // 10 min (merge + linear + cleanup)
    remove: 300_000,         // 5 min (stop services + remove container + remove repo)
    spawn: 300_000,          // 5 min (clone + build container + start)
    rebase: 300_000,         // 5 min
  };
  private static readonly DEFAULT_TIMEOUT_MS = 120_000; // 2 min

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

      // Warning-only timeout: log when operation exceeds expected duration
      // but let it complete naturally. Promise.race corrupts state because
      // the timed-out function keeps running and modifying state concurrently.
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

    // Chain onto the operation lock to serialize commands
    this.operationLock = this.operationLock.then(execute, execute);
    return this.operationLock;
  }

  /** Reload agent data from store (in case other code mutated it). */
  reload(): void {
    const fresh = store.getAgent(this.projectPath, this.issueId);
    if (fresh) {
      this._agent = fresh;
    }
  }

  /** Fix inconsistencies between in-memory and on-disk state.
   *  Reads directly from disk file (NOT store cache, which is the same object reference). */
  healState(): void {
    if (!this._agent.state) return;

    // If no operation running, git.op should be idle
    if (!this._agent.currentOperation && this._agent.state.git.op !== "idle") {
      this._agent.state.git.op = "idle";
    }

    // Read from DISK FILE — store.getAgent() returns the same cache reference as this._agent,
    // so comparing them is useless (same object). We need the actual file on disk.
    const configPath = join(
      this.projectPath, ".10timesdev", "agents", this.issueId, ".10timesdev", "config.json",
    );
    let disk: { state?: AgentState; currentOperation?: CurrentOperation | null } | null = null;
    try {
      if (existsSync(configPath)) {
        disk = JSON.parse(readFileSync(configPath, "utf-8"));
      }
    } catch {
      return;
    }
    if (!disk?.state) return;

    // If disk says no operation but memory has a stale one, trust disk
    if (!disk.currentOperation && this._agent.currentOperation) {
      this._agent.currentOperation = null;
    }

    // Terminal states can only advance forward — trust disk if it's more advanced
    const TERMINAL_LINEAR = new Set(["done", "cancelled"]);
    if (TERMINAL_LINEAR.has(disk.state.linearStatus) && !TERMINAL_LINEAR.has(this._agent.state.linearStatus)) {
      this._agent.state.linearStatus = disk.state.linearStatus;
    }

    const LIFECYCLE_ORDER = ["pending", "spawning", "active", "removed"];
    const diskIdx = LIFECYCLE_ORDER.indexOf(disk.state.lifecycle);
    const memIdx = LIFECYCLE_ORDER.indexOf(this._agent.state.lifecycle);
    if (diskIdx > memIdx) {
      this._agent.state.lifecycle = disk.state.lifecycle;
    }
  }

  // --- Task file helpers (extracted from agent-lifecycle.ts) ---

  private ensureGitIgnored(agentDir: string, entries: string[]): void {
    const gitignorePath = join(agentDir, ".gitignore");
    let content = "";
    try { content = readFileSync(gitignorePath, "utf-8"); } catch {}
    const lines = content.split("\n");
    const missing = entries.filter(e => !lines.some(l => l.trim() === e));
    if (missing.length > 0) {
      const addition = (content.endsWith("\n") || content === "" ? "" : "\n")
        + "# 10timesdev orchestrator files\n"
        + missing.join("\n") + "\n";
      appendFileSync(gitignorePath, addition, "utf-8");
    }
  }

  private writeTaskMd(agentDir: string, issue: linear.LinearIssue): void {
    const comments = issue.comments.nodes
      .map(c => `[${c.createdAt.split("T")[0]}] @${c.user.name || "unknown"}: ${c.body}`)
      .join("\n");
    const labels = issue.labels.nodes.map(l => l.name).join(", ");
    const content = `# ${issue.identifier}: ${issue.title}\n\n## Opis\n\n${issue.description || "Brak opisu"}\n\n## Priorytet\n${issue.priority}\n\n## Labelki\n${labels}\n\n## Status\n${issue.state.name}\n\n## Komentarze\n\n${comments}\n`;
    const dir = join(agentDir, ".10timesdev");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TASK.md"), content, "utf-8");
  }

  private writeClaudeMd(agentDir: string, ports: store.PortInfo): void {
    const content = `# Agent ${this.issueId} — ${this.projectName}

## Task

Read \`.10timesdev/TASK.md\`. This is your task from Linear.
Work ONLY on this task. Do not go beyond scope.

## Identity

- Issue: **${this.issueId}**
- Project: **${this.projectName}**
- Branch: \`agent/${this.issueId}\`
- Linear UUID: \`${this._agent.linearIssueUuid}\`

## Ports (ONLY these!)

| Service    | Port  |
|------------|-------|
| Dev server | ${ports.frontend[0]} |
| Service 2  | ${ports.frontend[1]} |
| Service 3  | ${ports.frontend[2]} |
| Backend 1  | ${ports.backend[0]} |
| Backend 2  | ${ports.backend[1]} |
| Backend 3  | ${ports.backend[2]} |

## Commit format

\`\`\`
🟢 [${this.issueId}] opis zmian
🟡 [${this.issueId}] opis zmian
\`\`\`

## Sync

\`\`\`bash
git fetch origin master
git rebase origin/master
git push origin HEAD:agent/${this.issueId} --force-with-lease
\`\`\`

## Before finishing

Before pushing, verify the project builds without errors:

\`\`\`bash
npm run build 2>&1 | tail -30
\`\`\`

If there are TypeScript or build errors, fix them before pushing. Do NOT push code that doesn't compile.

## When done

1. Push to origin/agent/${this.issueId}
2. Comment on Linear
3. Do nothing else
`;
    const dir = join(agentDir, ".10timesdev");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), content, "utf-8");
  }
}

function sanitizeError(err: unknown): string {
  return String(err).replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}
