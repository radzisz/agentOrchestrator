import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, unlinkSync, readdirSync, rmSync, renameSync } from "fs";
import * as cmd from "@/lib/cmd";
import { simpleGit } from "@/lib/cmd";
import { join } from "path";
import * as store from "@/lib/store";
import {
  DOCKER_IMAGE,
  ensureImage,
  removeContainer,
  getContainerStatus,
  getContainerLogs,
  createAndStartContainer,
  execInContainerAsync,
  execInContainerSimple,
  killProcesses,
  isProcessRunning,
  removeVolume,
} from "@/lib/docker";
import { eventBus } from "@/lib/event-bus";
import * as portManager from "./port-manager";
import * as runtime from "./runtime";
import { getProjectRuntimeConfig, detectPort } from "./runtime";
import * as linear from "./linear";
import type { PortInfo } from "./port-manager";

/** Log to console AND integration panel (so UI shows what happened) */
function log(message: string) {
  const msg = `[agent-lifecycle] ${message}`;
  console.log(msg);
  const g = globalThis as any;
  const buffers: Map<string, Array<{ ts: string; message: string }>> | undefined = g.__integrationLogs;
  if (buffers) {
    let buf = buffers.get("linear");
    if (!buf) { buf = []; buffers.set("linear", buf); }
    buf.push({ ts: new Date().toISOString(), message: msg });
    if (buf.length > 200) buf.splice(0, buf.length - 200);
  }
}

/**
 * Build Docker port bindings: host allocated ports → container native service ports.
 * If RUNTIME_CONFIG defines services with native ports (e.g. 4323, 4324, 4325),
 * map each allocated host port to the corresponding native container port.
 * This lets services run on their native ports inside the container while being
 * accessible via allocated ports from the host.
 */
function buildPortBindings(
  ports: store.PortInfo,
  projectPath: string
): { portBindings: Record<string, Array<{ HostPort: string }>>; exposedPorts: Record<string, object> } {
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  const exposedPorts: Record<string, object> = {};

  try {
    const rtCfg = getProjectRuntimeConfig(projectPath);
    if (rtCfg.services.length > 0) {
      const services = rtCfg.services.map((s, i) => ({
        ...s,
        port: s.port || detectPort(s.cmd, i),
      }));

      // Map each service: host allocatedPort → container nativePort
      for (let i = 0; i < services.length && i < ports.all.length; i++) {
        const nativePort = services[i].port;
        const allocatedPort = ports.all[i];
        portBindings[`${nativePort}/tcp`] = [{ HostPort: `${allocatedPort}` }];
        exposedPorts[`${nativePort}/tcp`] = {};
      }
      return { portBindings, exposedPorts };
    }
  } catch {
    // fallback to identity mapping
  }

  // Fallback: identity mapping (hostPort === containerPort)
  for (const port of ports.all) {
    portBindings[`${port}/tcp`] = [{ HostPort: `${port}` }];
    exposedPorts[`${port}/tcp`] = {};
  }
  return { portBindings, exposedPorts };
}

/** Ensure entries are in .gitignore of agent workspace */
function ensureGitIgnored(agentDir: string, entries: string[]): void {
  const gitignorePath = join(agentDir, ".gitignore");
  let content = "";
  try {
    content = readFileSync(gitignorePath, "utf-8");
  } catch {
    // no .gitignore yet
  }
  const lines = content.split("\n");
  const missing = entries.filter((e) => !lines.some((l) => l.trim() === e));
  if (missing.length > 0) {
    const addition = (content.endsWith("\n") || content === "" ? "" : "\n")
      + "# 10timesdev orchestrator files\n"
      + missing.join("\n") + "\n";
    appendFileSync(gitignorePath, addition, "utf-8");
  }
}

/** Strip tokens/secrets from error messages */
function sanitizeError(err: unknown): string {
  return String(err).replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}

/**
 * Filter Claude's exec output — remove docker/service noise, keep only Claude's text.
 * The exec stream captures stdout from `claude -p`, which should be clean,
 * but tee + shell wrappers can leak noise.
 */
function filterClaudeOutput(raw: string): string {
  if (!raw) return "";
  const lines = raw.split("\n").filter((line) => {
    // Skip Docker timestamps (e.g. "2026-03-04T23:32:21.106949157Z ...")
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/.test(line)) return false;
    // Skip entrypoint/runtime noise
    if (line.includes("[entrypoint]")) return false;
    if (line.includes("[runtime]")) return false;
    // Skip node warnings and dev server output
    if (line.includes("node --trace-warnings")) return false;
    if (line.includes("Unable to open browser automatically")) return false;
    if (line.includes("Starting framework dev server")) return false;
    if (line.includes("Local dev server ready")) return false;
    if (line.includes("Waiting for framework dev server")) return false;
    // Skip ASCII box drawing (dev server banners)
    if (/^[\s│┌┐└┘─╭╮╰╯┤├]+$/.test(line)) return false;
    return true;
  });
  return lines.join("\n").trim();
}

/**
 * Agent lifecycle — unified container model
 *
 * Container runs `sleep infinity` (always alive).
 * Claude is launched inside via `docker exec`.
 * Preview services also run inside the same container.
 */

export interface SpawnOptions {
  projectName: string;
  issueId: string;
  linearIssueUuid: string;
  customPrompt?: string;
}

export async function spawn(options: SpawnOptions): Promise<string> {
  const { projectName, issueId, linearIssueUuid, customPrompt } = options;

  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const cfg = store.getProjectConfig(project.path);
  const repoPath = project.path;
  const agentDir = join(repoPath, ".10timesdev", "agents", issueId);

  // Check if agent already exists
  const existingAgent = store.getAgent(project.path, issueId);
  if (existingAgent && existsSync(join(agentDir, ".git"))) {
    if (existingAgent.spawned) {
      log(`SKIP ${issueId}: already spawned (status=${existingAgent.status})`);
      return issueId;
    }
    // Zombie state: clone exists but spawn never completed — re-attempt from Docker step
    log(`RE-SPAWN ${issueId}: clone exists but spawned=false (status=${existingAgent.status}), retrying Docker setup`);
  }

  // Fetch issue from Linear (by UUID)
  log(`SPAWN ${issueId}: fetching issue from Linear`);
  const issue = await linear.getIssue(cfg.LINEAR_API_KEY, linearIssueUuid);
  if (!issue) {
    log(`SPAWN ${issueId}: issue not found in Linear (uuid=${linearIssueUuid})`);
    throw new Error(`Issue ${issueId} not found in Linear`);
  }

  // Create/update agent record
  const now = new Date().toISOString();
  const agent: store.AgentData = existingAgent || {
    issueId,
    title: issue.title,
    linearIssueUuid: issue.id,
    status: "SPAWNING",
    branch: `agent/${issueId}`,
    agentDir,
    servicesEnabled: false,
    spawned: false,
    previewed: false,
    notified: false,
    createdAt: now,
    updatedAt: now,
  };
  agent.status = "SPAWNING";
  agent.title = issue.title;
  agent.description = issue.description || undefined;
  agent.linearIssueUuid = issue.id;
  // Add to in-memory cache immediately so UI sees it (don't write to disk — that creates dirs blocking clone)
  store.cacheAgent(project.path, issueId, agent);

  try {
    // Allocate port
    const ports = portManager.allocate(projectName, issueId);
    agent.portSlot = ports.slot;
    agent.containerName = `agent-${issueId}`;
    agent.branch = `agent/${issueId}`;
    agent.agentDir = agentDir;

    // Clone repo
    if (!existsSync(join(agentDir, ".git"))) {
      log(`SPAWN ${issueId}: cloning repo to ${agentDir}`);
      mkdirSync(join(repoPath, ".10timesdev", "agents"), { recursive: true });

      let cloneUrl = cfg.REPO_URL || await simpleGit(repoPath).remote(["get-url", "origin"]) as unknown as string;
      if (typeof cloneUrl === "string") cloneUrl = cloneUrl.trim();
      const githubToken = cfg.GITHUB_TOKEN;
      if (githubToken && cloneUrl.startsWith("https://github.com/")) {
        cloneUrl = cloneUrl.replace(
          "https://github.com",
          `https://x-access-token:${githubToken}@github.com`
        );
      }

      // Clone to temp dir, then rename to agentDir (avoids "not empty" error)
      const tmpDir = join(repoPath, ".10timesdev", "agents", `_tmp_${issueId}_${Date.now()}`);
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
      if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });

      await simpleGit().clone(cloneUrl, tmpDir, ["--depth", "50"]);

      // Rename temp → agentDir
      renameSync(tmpDir, agentDir);

      // Configure git for agent
      const agentGit = simpleGit(agentDir);
      await agentGit.addConfig("credential.helper", "");
      await agentGit.addConfig("core.autocrlf", "input");

      // Set remote with token for push
      if (githubToken && cloneUrl.includes("x-access-token")) {
        await agentGit.remote(["set-url", "origin", cloneUrl]);
      }
    }

    // Now safe to save agent config (agentDir exists after clone)
    log(`SPAWN ${issueId}: saving agent record`);
    store.saveAgent(project.path, issueId, agent);

    // Copy .env if exists
    const envFile = join(repoPath, ".env");
    if (existsSync(envFile)) {
      writeFileSync(join(agentDir, ".env"), readFileSync(envFile));
    }

    // Install dependencies
    if (existsSync(join(agentDir, "pnpm-lock.yaml"))) {
      await cmd.run("pnpm install --frozen-lockfile", { cwd: agentDir, source: "agent-lifecycle", timeout: 120000 });
    } else if (existsSync(join(agentDir, "package-lock.json"))) {
      await cmd.run("npm ci", { cwd: agentDir, source: "agent-lifecycle", timeout: 120000 });
    }

    // Ensure orchestrator files are git-ignored in agent workspace
    ensureGitIgnored(agentDir, [".10timesdev", "agent-output.log", ".agent-container", "messages.jsonl"]);

    // Migrate legacy root-level orchestrator files into .10timesdev/
    const tenxDir = join(agentDir, ".10timesdev");
    if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });
    for (const fname of ["TASK.md", "CLAUDE.md", "messages.jsonl"]) {
      const oldPath = join(agentDir, fname);
      const newPath = join(tenxDir, fname);
      if (existsSync(oldPath)) {
        if (!existsSync(newPath)) {
          writeFileSync(newPath, readFileSync(oldPath));
        }
        try { unlinkSync(oldPath); } catch {}
      }
    }

    // Write TASK.md
    writeTaskMd(agentDir, issue);

    // Write CLAUDE.md
    writeClaudeMd(agentDir, issueId, projectName, issue.id, ports, repoPath);

    // Log initial task as first human message
    const initialMessage = customPrompt || `${issue.identifier}: ${issue.title}\n\n${issue.description || ""}`;
    store.appendMessage(project.path, issueId, "human", initialMessage);

    // Comment on Linear
    await linear.addComment(
      cfg.LINEAR_API_KEY,
      issue.id,
      `🤖 Agent started\n\nProject: ${projectName}\nSlot: ${ports.slot} (ports: ${ports.frontend[0]}, ${ports.backend[0]}...)\nBranch: agent/${issueId}`
    );

    // Start Docker container (sleep infinity — always alive)
    log(`SPAWN ${issueId}: creating Docker container`);
    await ensureImage();
    await removeContainer(`agent-${issueId}`);

    // Map allocated host ports → native service ports inside container
    const { portBindings } = buildPortBindings(ports, project.path);

    await createAndStartContainer({
      image: DOCKER_IMAGE,
      name: `agent-${issueId}`,
      env: [
        `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
        `LINEAR_API_KEY=${cfg.LINEAR_API_KEY}`,
        `LINEAR_ISSUE_ID=${issue.id}`,
        `ISSUE_ID=${issueId}`,
      ],
      binds: [
        `${agentDir}:/workspace`,
        "claude-auth:/home/agent/.claude",
        `agent-node-modules-${issueId}:/workspace/node_modules`,
      ],
      portBindings,
    });

    // Launch Claude inside the container via exec
    log(`SPAWN ${issueId}: launching Claude in container`);
    const prompt = customPrompt ||
      "Read .10timesdev/TASK.md — this is your task from Linear. Read .10timesdev/CLAUDE.md — it contains your ports, identity, and rules. Complete the task. When done, comment on Linear as instructed in CLAUDE_GLOBAL.md.";

    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const { execId: spawnExecId } = await execInContainerAsync(`agent-${issueId}`, [
      "sh", "-c", `gosu agent claude -p --dangerously-skip-permissions --model sonnet '${escapedPrompt}' 2>&1`,
    ], {
      user: "root",
      workingDir: "/workspace",
      env: [
        `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
        `LINEAR_API_KEY=${cfg.LINEAR_API_KEY}`,
        `LINEAR_ISSUE_ID=${issue.id}`,
        `ISSUE_ID=${issueId}`,
      ],
      onExit: async (exitCode, output) => {
        // Skip if a newer exec has been started (prevents stale onExit from overwriting status)
        if (activeExecIds.get(issueId) !== spawnExecId) {
          console.log(`[agent-lifecycle] Ignoring stale onExit for ${issueId} (exec ${spawnExecId.slice(0, 8)})`);
          return;
        }
        console.log(`[agent-lifecycle] Claude exited for ${issueId} with code ${exitCode}, output length: ${output?.length || 0}`);
        const agentResponse = filterClaudeOutput(output?.trim() || "");
        if (agentResponse) {
          const tail = agentResponse.split("\n").slice(-50).join("\n");
          store.appendMessage(project.path, issueId, "agent", tail);
        }
        const currentAgent = store.getAgent(project.path, issueId);
        if (currentAgent && currentAgent.status === "RUNNING") {
          currentAgent.status = "EXITED";
          currentAgent.updatedAt = new Date().toISOString();
          store.saveAgent(project.path, issueId, currentAgent);
          store.appendLog(project.path, `agent-${issueId}`, `claude exited code=${exitCode}`);
          eventBus.emit("agent:exited", { agentId: issueId, issueId });
        }
      },
    });
    activeExecIds.set(issueId, spawnExecId);

    agent.status = "RUNNING";
    agent.spawned = true;
    store.saveAgent(project.path, issueId, agent);

    log(`SPAWN ${issueId}: ✓ fully spawned (container=agent-${issueId}, slot=${ports.slot})`);
    store.appendLog(project.path, `agent-${issueId}`, `spawned container=agent-${issueId} branch=agent/${issueId} slot=${ports.slot}`);

    eventBus.emit("agent:spawned", {
      agentId: issueId,
      issueId,
      projectName,
      containerName: `agent-${issueId}`,
      branch: `agent/${issueId}`,
    });

    return issueId;
  } catch (error) {
    const safeMsg = sanitizeError(error);
    log(`SPAWN ${issueId}: ✗ FAILED — ${safeMsg}`);

    agent.status = "EXITED";
    store.saveAgent(project.path, issueId, agent);

    store.appendLog(project.path, `agent-${issueId}`, `error: ${safeMsg}`);

    eventBus.emit("agent:error", {
      agentId: issueId,
      issueId,
      error: safeMsg,
    });

    throw new Error(safeMsg);
  }
}

export async function stop(projectName: string, issueId: string): Promise<void> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const agent = store.getAgent(project.path, issueId);
  if (!agent) throw new Error(`Agent not found: ${issueId}`);

  // Kill Claude process but keep container alive
  if (agent.containerName) {
    await killProcesses(agent.containerName, "claude.*--dangerously-skip-permissions");
  }

  agent.status = "EXITED";
  store.saveAgent(project.path, issueId, agent);

  store.appendLog(project.path, `agent-${issueId}`, "stopped (claude killed, container alive)");
  eventBus.emit("agent:stopped", { agentId: issueId, issueId });
}

const TERMINAL_STATUSES = new Set(["DONE", "REMOVED", "CANCELLED", "CLEANUP"]);

/** Track active exec per agent to prevent stale onExit from overwriting status */
const activeExecIds = new Map<string, string>();

export async function wake(projectName: string, issueId: string, message?: string, options?: { reset?: boolean }): Promise<void> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const agent = store.getAgent(project.path, issueId);
  if (!agent) throw new Error(`Agent not found: ${issueId}`);
  if (TERMINAL_STATUSES.has(agent.status)) {
    throw new Error(`Agent ${issueId} is in terminal state: ${agent.status}`);
  }
  const cfg = store.getProjectConfig(project.path);

  if (!agent.agentDir || !agent.containerName) {
    throw new Error("Agent has no directory or container");
  }

  const tenxDir = join(agent.agentDir, ".10timesdev");
  if (!existsSync(tenxDir)) mkdirSync(tenxDir, { recursive: true });
  const taskMdPath = join(tenxDir, "TASK.md");

  // Create TASK.md if missing (e.g. after cleanup or migration)
  if (!existsSync(taskMdPath)) {
    writeFileSync(taskMdPath, `# ${agent.issueId}: ${agent.title || "Task"}\n\n${agent.description || ""}\n`, "utf-8");
  }

  if (options?.reset) {
    const content = readFileSync(taskMdPath, "utf-8");
    const cleaned = content.replace(/\n\n## New instructions from human\n\n[\s\S]*$/m, "");
    writeFileSync(taskMdPath, cleaned, "utf-8");
  }

  // Append new instructions to TASK.md
  if (message) {
    appendFileSync(
      taskMdPath,
      `\n\n## New instructions from human\n\n${message}\n`
    );
  }

  // Log human message
  if (message) {
    store.appendMessage(project.path, issueId, "human", message);
  }

  // Ensure container is alive, recreate if dead
  await ensureContainerAlive(agent, project.path);

  // Kill any running Claude process before starting new one
  await killProcesses(agent.containerName, "claude.*--dangerously-skip-permissions");

  // Launch Claude via exec
  const prompt = message
    ? "Read .10timesdev/TASK.md — at the end of the file there are NEW INSTRUCTIONS from human. Read .10timesdev/CLAUDE.md. Apply the changes according to the new instructions. When done, comment on Linear."
    : "Read .10timesdev/TASK.md and .10timesdev/CLAUDE.md. Continue working. When done, comment on Linear.";

  const escapedWakePrompt = prompt.replace(/'/g, "'\\''");
  const { execId: wakeExecId } = await execInContainerAsync(agent.containerName, [
    "sh", "-c", `gosu agent claude -p --dangerously-skip-permissions --model sonnet '${escapedWakePrompt}' 2>&1`,
  ], {
    user: "root",
    workingDir: "/workspace",
    env: [
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
      `LINEAR_API_KEY=${cfg.LINEAR_API_KEY || ""}`,
      `LINEAR_ISSUE_ID=${agent.linearIssueUuid || ""}`,
      `ISSUE_ID=${issueId}`,
    ],
    onExit: async (exitCode, output) => {
      // Skip if a newer exec has been started
      if (activeExecIds.get(issueId) !== wakeExecId) {
        console.log(`[agent-lifecycle] Ignoring stale onExit for ${issueId} (wake exec ${wakeExecId.slice(0, 8)})`);
        return;
      }
      console.log(`[agent-lifecycle] Claude exited for ${issueId} (wake) with code ${exitCode}, output length: ${output?.length || 0}`);
      const agentResponse = filterClaudeOutput(output?.trim() || "");
      if (agentResponse) {
        const tail = agentResponse.split("\n").slice(-50).join("\n");
        store.appendMessage(project.path, issueId, "agent", tail);
      }
      // Touch changed files to trigger HMR (inotify doesn't work on Windows bind mounts)
      if (agent.containerName) {
        try {
          await cmd.dockerExec(agent.containerName,
            'cd /workspace && git diff --name-only HEAD~1 2>/dev/null | xargs -r touch 2>/dev/null || true',
            { source: "agent-lifecycle", timeout: 10000 });
        } catch {}
      }
      const currentAgent = store.getAgent(project.path, issueId);
      if (currentAgent && currentAgent.status === "RUNNING") {
        currentAgent.status = "EXITED";
        currentAgent.updatedAt = new Date().toISOString();
        store.saveAgent(project.path, issueId, currentAgent);
        store.appendLog(project.path, `agent-${issueId}`, `claude exited (wake) code=${exitCode}`);
        eventBus.emit("agent:exited", { agentId: issueId, issueId });
      }
    },
  });
  activeExecIds.set(issueId, wakeExecId);

  agent.status = "RUNNING";
  store.saveAgent(project.path, issueId, agent);

  store.appendLog(project.path, `agent-${issueId}`, `wake message=${message || "resumed"}`);
  eventBus.emit("agent:wake", {
    agentId: issueId,
    issueId,
    message: message || "resumed",
  });
}

export async function cleanup(projectName: string, issueId: string): Promise<void> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const agent = store.getAgent(project.path, issueId);
  if (!agent) return;

  // 1. Mark as REMOVED immediately so UI updates
  agent.status = "REMOVED";
  agent.updatedAt = new Date().toISOString();
  store.saveAgent(project.path, issueId, agent);
  eventBus.emit("agent:cleanup", { agentId: issueId, issueId });

  // 2. Back up .10timesdev metadata before any destructive ops
  const metaBackup = new Map<string, Buffer>();
  if (agent.agentDir) {
    const metaDir = join(agent.agentDir, ".10timesdev");
    if (existsSync(metaDir)) {
      try {
        for (const f of readdirSync(metaDir)) {
          try { metaBackup.set(f, readFileSync(join(metaDir, f))); } catch {}
        }
      } catch {}
    }
  }

  // 3. Everything else runs in background — never blocks the request or event loop
  (async () => {
    const branch = agent.branch || `agent/${issueId}`;

    // Stop services (async Docker API)
    try { await runtime.stopRuntime(projectName, branch, "LOCAL"); } catch {}

    // Remove container (async Docker API)
    if (agent.containerName) {
      try { await removeContainer(agent.containerName); } catch {}
    }

    // Remove node_modules volume (async Docker API)
    try { await removeVolume(`agent-node-modules-${issueId}`); } catch {}

    // Delete remote branch (async, network — may be slow)
    try { await simpleGit(project.path).push("origin", `:agent/${issueId}`); } catch {}

    // Delete agent directory — use rename + spawn to avoid blocking event loop
    if (agent.agentDir && existsSync(agent.agentDir)) {
      const trashName = `_trash_${issueId}_${Date.now()}`;
      const trashDir = join(agent.agentDir, "..", trashName);
      try {
        // Rename is instant on same filesystem
        renameSync(agent.agentDir, trashDir);
        // Restore .10timesdev under original path
        if (metaBackup.size > 0) {
          const metaDir = join(agent.agentDir, ".10timesdev");
          mkdirSync(metaDir, { recursive: true });
          for (const [f, buf] of metaBackup) {
            try { writeFileSync(join(metaDir, f), buf); } catch {}
          }
        }
        // Delete the renamed dir in background (non-blocking)
        const { rm } = await import("fs/promises");
        rm(trashDir, { recursive: true, force: true }).catch(() => {});
      } catch {
        // Rename failed (e.g. cross-device) — fallback: async delete in-place
        try {
          const { rm } = await import("fs/promises");
          // Save metadata first
          if (metaBackup.size > 0) {
            const metaDir = join(agent.agentDir, ".10timesdev");
            mkdirSync(metaDir, { recursive: true });
            for (const [f, buf] of metaBackup) {
              try { writeFileSync(join(metaDir, f), buf); } catch {}
            }
          }
          // Delete everything except .10timesdev
          const entries = readdirSync(agent.agentDir);
          for (const e of entries) {
            if (e === ".10timesdev") continue;
            rm(join(agent.agentDir, e), { recursive: true, force: true }).catch(() => {});
          }
        } catch {}
      }
    }

    store.appendLog(project.path, `agent-${issueId}`, "cleanup complete");
  })().catch((err) => {
    console.error(`[agent-lifecycle] Background cleanup failed for ${issueId}:`, err);
  });
}

/**
 * Ensure agent container is running (sleep infinity).
 * If dead or missing — recreate it. Used by runtime.ts before launching preview.
 */
export async function ensureContainerAlive(agent: store.AgentData, projectPath: string, opts?: { skipServiceAutoStart?: boolean }): Promise<void> {
  if (!agent.containerName || !agent.agentDir) {
    throw new Error(`Agent ${agent.issueId} has no container or directory`);
  }

  const status = await getContainerStatus(agent.containerName);
  if (status && status.status === "running") return; // already alive

  console.log(`[agent-lifecycle] Container ${agent.containerName} not running, recreating...`);
  await removeContainer(agent.containerName);
  await ensureImage();

  const cfg = store.getProjectConfig(projectPath);
  const ports = agent.portSlot !== undefined ? store.getPortsForSlot(agent.portSlot) : null;

  let portBindings: Record<string, Array<{ HostPort: string }>> = {};
  if (ports) {
    ({ portBindings } = buildPortBindings(ports, projectPath));
  }

  await createAndStartContainer({
    image: DOCKER_IMAGE,
    name: agent.containerName,
    env: [
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
      `LINEAR_API_KEY=${cfg.LINEAR_API_KEY || ""}`,
      `LINEAR_ISSUE_ID=${agent.linearIssueUuid || ""}`,
      `ISSUE_ID=${agent.issueId}`,
    ],
    binds: [
      `${agent.agentDir}:/workspace`,
      "claude-auth:/home/agent/.claude",
      `agent-node-modules-${agent.issueId}:/workspace/node_modules`,
    ],
    portBindings,
  });
  console.log(`[agent-lifecycle] Container ${agent.containerName} started`);

  // Auto-start services if enabled (skip when called from runtime.startLocal to avoid circular calls)
  if (!opts?.skipServiceAutoStart && agent.servicesEnabled && agent.branch) {
    const config = store.getConfig();
    const project = config.projects.find((p) => p.path === projectPath);
    if (project) {
      console.log(`[agent-lifecycle] Auto-starting services for ${agent.issueId}`);
      runtime.startLocal(project.name, agent.branch).catch((err) => {
        console.warn(`[agent-lifecycle] Auto-start services failed for ${agent.issueId}:`, err);
      });
    }
  }
}

export async function getLogs(projectName: string, issueId: string, tail: number = 100): Promise<string> {
  const project = store.getProjectByName(projectName);
  if (!project) return "";
  const agent = store.getAgent(project.path, issueId);
  if (!agent?.containerName) return "";
  return getContainerLogs(agent.containerName, tail);
}

export async function getStatus(projectName: string, issueId: string) {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const agent = store.getAgent(project.path, issueId);
  if (!agent) throw new Error(`Agent not found: ${issueId}`);

  let containerStatus = null;
  if (agent.containerName) {
    containerStatus = await getContainerStatus(agent.containerName);
  }

  // Also check if Claude is actually running inside
  let claudeRunning = false;
  if (agent.containerName && containerStatus?.status === "running") {
    claudeRunning = await isProcessRunning(agent.containerName, "claude.*--dangerously-skip-permissions");
  }

  return { agent, containerStatus, projectName, claudeRunning };
}

// --- Helpers ---

// getRemoteUrl removed — using simpleGit().remote(["get-url", "origin"]) inline

function writeTaskMd(agentDir: string, issue: linear.LinearIssue): void {
  const comments = issue.comments.nodes
    .map(
      (c) =>
        `[${c.createdAt.split("T")[0]}] @${c.user.name || "unknown"}: ${c.body}`
    )
    .join("\n");

  const labels = issue.labels.nodes.map((l) => l.name).join(", ");

  const content = `# ${issue.identifier}: ${issue.title}

## Opis

${issue.description || "Brak opisu"}

## Priorytet
${issue.priority}

## Labelki
${labels}

## Status
${issue.state.name}

## Komentarze

${comments}
`;

  const dir = join(agentDir, ".10timesdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TASK.md"), content, "utf-8");
}

function writeClaudeMd(
  agentDir: string,
  issueId: string,
  projectName: string,
  linearUuid: string,
  ports: PortInfo,
  repoPath: string
): void {
  const content = `# Agent ${issueId} — ${projectName}

## Task

Read \`.10timesdev/TASK.md\`. This is your task from Linear.
Work ONLY on this task. Do not go beyond scope.

## Identity

- Issue: **${issueId}**
- Project: **${projectName}**
- Branch: \`agent/${issueId}\`
- Linear UUID: \`${linearUuid}\`

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
🟢 [${issueId}] opis zmian
🟡 [${issueId}] opis zmian
\`\`\`

## Sync

\`\`\`bash
git fetch origin master
git rebase origin/master
git push origin HEAD:agent/${issueId} --force-with-lease
\`\`\`

## Before finishing

Before pushing, verify the project builds without errors:

\`\`\`bash
npm run build 2>&1 | tail -30
\`\`\`

If there are TypeScript or build errors, fix them before pushing. Do NOT push code that doesn't compile.

## When done

1. Push to origin/agent/${issueId}
2. Comment on Linear
3. Do nothing else
`;

  const dir = join(agentDir, ".10timesdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), content, "utf-8");
}
