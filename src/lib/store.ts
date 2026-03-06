import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, appendFileSync, rmSync, statSync } from "fs";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface AppConfig {
  projects: ProjectEntry[];
  integrations: Record<string, {
    enabled: boolean;
    config?: Record<string, string>;
  }>;
  nextPortSlot: number;
}

export type AgentStatus =
  | "PENDING" | "SPAWNING" | "RUNNING" | "EXITED" | "WAITING"
  | "PREVIEW" | "IN_REVIEW" | "MERGING" | "REBASING" | "DONE" | "CANCELLED" | "CLEANUP" | "REMOVED";

export interface AgentData {
  issueId: string;
  linearIssueUuid?: string;
  title: string;
  description?: string;
  status: AgentStatus;
  containerName?: string;
  branch?: string;
  agentDir?: string;
  portSlot?: number;
  servicesEnabled: boolean;
  spawned: boolean;
  previewed: boolean;
  notified: boolean;
  rebaseResult?: { success: boolean; steps: { cmd: string; ok: boolean; output: string }[]; error?: string; conflict?: boolean; conflictFiles?: string[] };
  createdAt: string;
  updatedAt: string;
  // Aggregate state
  state?: import("@/lib/agent-aggregate/types").AgentState;
  currentOperation?: import("@/lib/agent-aggregate/types").CurrentOperation | null;
  // UI status — derived, always written on save
  uiStatus?: import("@/lib/agent-aggregate/types").UiState;
}

export type RuntimeType = "LOCAL" | "REMOTE";
export type RuntimeStatus = "STARTING" | "DEPLOYING" | "RUNNING" | "STOPPED" | "FAILED";

export interface RuntimeData {
  type: RuntimeType;
  status: RuntimeStatus;
  branch: string;
  mode?: "container" | "host";
  hostPids?: number[];
  servicesEnabled?: boolean;
  containerName?: string;
  portSlot?: number;
  previewUrl?: string;
  supabaseUrl?: string;
  supabaseBranchId?: string;
  servicePortMap?: Array<{ name: string; hostPort: number; healthPath?: string }>;
  netlifyDeployIds?: Array<{ siteName: string; deployId: string }>;
  operationLog?: Array<{ ts: string; msg: string; ok: boolean }>;
  expiresAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectConfig {
  [key: string]: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(process.cwd(), "config.json");

export function orchestratorDir(projectPath: string): string {
  return join(projectPath, ".10timesdev");
}

function logsDir(projectPath: string): string {
  return join(orchestratorDir(projectPath), "logs");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// IN-MEMORY CACHE
// All reads come from memory. All writes go to memory + disk (write-through).
// Cache is populated lazily on first access per entity.
// ---------------------------------------------------------------------------

let _appConfig: AppConfig | null = null;
const _projectConfigs = new Map<string, ProjectConfig>();          // projectPath → config
const _agents = new Map<string, Map<string, AgentData>>();         // projectPath → (issueId → agent)
const _agentsLoaded = new Set<string>();                           // projectPaths where agents are fully loaded
const _runtimes = new Map<string, RuntimeData[]>();                // projectPath → runtime[]
const _runtimesLoaded = new Set<string>();                         // projectPaths where runtimes are fully loaded

/** Force reload from disk on next access. Call from force-refresh endpoint. */
export function invalidateCache(projectPath?: string): void {
  if (projectPath) {
    _agentsLoaded.delete(projectPath);
    _agents.delete(projectPath);
    _runtimesLoaded.delete(projectPath);
    _runtimes.delete(projectPath);
    _projectConfigs.delete(projectPath);
  } else {
    _appConfig = null;
    _projectConfigs.clear();
    _agents.clear();
    _agentsLoaded.clear();
    _runtimes.clear();
    _runtimesLoaded.clear();
  }
}

// ---------------------------------------------------------------------------
// App Config (config.json) — cached
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AppConfig = {
  projects: [],
  integrations: {},
  nextPortSlot: 0,
};

export function getConfig(): AppConfig {
  if (_appConfig) return _appConfig;
  if (!existsSync(CONFIG_PATH)) {
    _appConfig = { ...DEFAULT_CONFIG };
    saveConfig(_appConfig);
    return _appConfig;
  }
  _appConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  return _appConfig!;
}

export function saveConfig(config: AppConfig): void {
  _appConfig = config;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Project Config — cached
// ---------------------------------------------------------------------------

/** Keys that contain secrets — stored in .env.10timesdev (not committed to git) */
const SECRET_KEYS = new Set([
  "LINEAR_API_KEY",
  "GITHUB_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "NETLIFY_AUTH_TOKEN",
]);

function secretsEnvPath(projectPath: string): string {
  return join(projectPath, ".env.10timesdev");
}

function projectConfigJsonPath(projectPath: string): string {
  return join(orchestratorDir(projectPath), "config.json");
}

function readEnvFile(filePath: string): ProjectConfig {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const result: ProjectConfig = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    result[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
  }
  return result;
}

function writeEnvFile(filePath: string, data: ProjectConfig): void {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) {
      lines.push(`${key}=${value}`);
    }
  }
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

function readJsonConfig(filePath: string): ProjectConfig {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonConfig(filePath: string, data: ProjectConfig): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function getProjectConfig(projectPath: string): ProjectConfig {
  const cached = _projectConfigs.get(projectPath);
  if (cached) return cached;
  const secrets = readEnvFile(secretsEnvPath(projectPath));
  const config = readJsonConfig(projectConfigJsonPath(projectPath));
  const merged = { ...config, ...secrets };
  _projectConfigs.set(projectPath, merged);
  return merged;
}

export function saveProjectConfig(projectPath: string, data: ProjectConfig): void {
  const secrets: ProjectConfig = {};
  const config: ProjectConfig = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (SECRET_KEYS.has(key)) {
      secrets[key] = value;
    } else {
      config[key] = value;
    }
  }

  writeEnvFile(secretsEnvPath(projectPath), secrets);
  writeJsonConfig(projectConfigJsonPath(projectPath), config);
  // Update cache
  _projectConfigs.set(projectPath, { ...data });
}

export function getProjectByName(name: string): ProjectEntry | undefined {
  const config = getConfig();
  return config.projects.find((p) => p.name === name);
}

export interface ProjectWithConfig extends ProjectEntry {
  config: ProjectConfig;
}

export function listProjects(): ProjectWithConfig[] {
  const config = getConfig();
  return config.projects.map((p) => ({
    ...p,
    config: getProjectConfig(p.path),
  }));
}

export function addProject(entry: ProjectEntry): void {
  const config = getConfig();
  const existing = config.projects.findIndex((p) => p.name === entry.name);
  if (existing >= 0) {
    config.projects[existing] = entry;
  } else {
    config.projects.push(entry);
  }
  saveConfig(config);
}

export function removeProject(name: string): void {
  const config = getConfig();
  config.projects = config.projects.filter((p) => p.name !== name);
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Agents — cached in memory
// ---------------------------------------------------------------------------

function agentFilePath(projectPath: string, issueId: string): string {
  return join(orchestratorDir(projectPath), "agents", issueId, ".10timesdev", "config.json");
}

/** Ensure all agents for a project are loaded into cache */
function ensureAgentsLoaded(projectPath: string): Map<string, AgentData> {
  if (_agentsLoaded.has(projectPath)) {
    return _agents.get(projectPath) || new Map();
  }

  const map = new Map<string, AgentData>();

  // Clean up legacy agent-*.json files
  const dir = orchestratorDir(projectPath);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (/^agent-.+\.json$/.test(f)) {
        try { unlinkSync(join(dir, f)); } catch {}
      }
    }
  }

  // Load all agents from disk
  const agentsDir = join(dir, "agents");
  if (existsSync(agentsDir)) {
    for (const d of readdirSync(agentsDir)) {
      if (d.startsWith("_tmp_") || d.startsWith("_trash_")) continue;
      const cfgPath = join(agentsDir, d, ".10timesdev", "config.json");
      if (existsSync(cfgPath)) {
        try {
          const data = JSON.parse(readFileSync(cfgPath, "utf-8")) as AgentData;
          map.set(d, data);
        } catch {}
      } else if (existsSync(join(agentsDir, d, ".git"))) {
        // Directory exists (clone done) but no config.json — create minimal record
        const now = new Date().toISOString();
        const stub: AgentData = {
          issueId: d,
          title: d,
          status: "EXITED",
          branch: `agent/${d}`,
          agentDir: join(agentsDir, d),
          servicesEnabled: false,
          spawned: false,
          previewed: false,
          notified: false,
          createdAt: now,
          updatedAt: now,
        };
        map.set(d, stub);
        // Persist so next load finds it
        const p = agentFilePath(projectPath, d);
        ensureDir(dirname(p));
        writeFileSync(p, JSON.stringify(stub, null, 2), "utf-8");
      }
    }
  }

  _agents.set(projectPath, map);
  _agentsLoaded.add(projectPath);
  return map;
}

export function getAgent(projectPath: string, issueId: string): AgentData | null {
  const map = ensureAgentsLoaded(projectPath);
  const agent = map.get(issueId) || null;
  // Prune from cache if config.json was deleted from disk
  if (agent && !existsSync(agentFilePath(projectPath, issueId))) {
    map.delete(issueId);
    return null;
  }
  if (agent && !agent.state) {
    // Bootstrap aggregate state from legacy status on first access
    const { stateFromLegacy } = require("@/lib/agent-aggregate/compat");
    agent.state = stateFromLegacy(agent);
    agent.currentOperation = null;
  }
  if (agent && agent.state && !agent.uiStatus) {
    const { deriveUiStatus } = require("@/lib/agent-aggregate/types");
    agent.uiStatus = deriveUiStatus(agent.state, agent.currentOperation ?? null);
  }
  return agent;
}

/** Add agent to in-memory cache without writing to disk. Use when disk write would cause side-effects. */
export function cacheAgent(projectPath: string, issueId: string, data: AgentData): void {
  const map = ensureAgentsLoaded(projectPath);
  map.set(issueId, data);
}

export function saveAgent(projectPath: string, issueId: string, data: AgentData): void {
  // Derive statuses from aggregate state
  if (data.state) {
    const { deriveLegacyStatus } = require("@/lib/agent-aggregate/compat");
    const { deriveUiStatus } = require("@/lib/agent-aggregate/types");
    data.status = deriveLegacyStatus(data.state, data.currentOperation ?? null);
    data.uiStatus = deriveUiStatus(data.state, data.currentOperation ?? null);
  }

  // Update cache
  const map = ensureAgentsLoaded(projectPath);
  data.updatedAt = new Date().toISOString();
  map.set(issueId, data);

  // Write to disk
  const p = agentFilePath(projectPath, issueId);
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

export function listAgents(projectPath: string): Array<AgentData & { _projectPath: string }> {
  const map = ensureAgentsLoaded(projectPath);

  // Prune agents whose config.json no longer exists on disk (e.g. directory deleted manually)
  for (const [id, agent] of map) {
    const cfgPath = agentFilePath(projectPath, id);
    if (!existsSync(cfgPath)) {
      map.delete(id);
    }
  }

  return Array.from(map.values()).map((agent) => {
    // Bootstrap state/uiStatus if missing (same as getAgent)
    if (!agent.state) {
      const { stateFromLegacy } = require("@/lib/agent-aggregate/compat");
      agent.state = stateFromLegacy(agent);
      agent.currentOperation = null;
    }
    if (!agent.uiStatus) {
      const { deriveUiStatus } = require("@/lib/agent-aggregate/types");
      agent.uiStatus = deriveUiStatus(agent.state, agent.currentOperation ?? null);
    }
    return { ...agent, _projectPath: projectPath };
  });
}

export function deleteAgent(projectPath: string, issueId: string): void {
  // Remove from cache
  const map = _agents.get(projectPath);
  if (map) map.delete(issueId);

  // Remove from disk
  const agentDataDir = join(orchestratorDir(projectPath), "agents", issueId, ".10timesdev");
  if (existsSync(agentDataDir)) {
    try { rmSync(agentDataDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Runtimes — cached in memory
// ---------------------------------------------------------------------------

function issueIdFromBranch(branch: string): string | null {
  const m = branch.match(/^agent\/(.+)$/);
  return m ? m[1] : null;
}

function runtimeFilePath(projectPath: string, type: RuntimeType, branch: string): string {
  const issueId = issueIdFromBranch(branch);
  if (issueId) {
    return join(orchestratorDir(projectPath), "agents", issueId, ".10timesdev", `rt-${type.toLowerCase()}.json`);
  }
  const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
  return join(orchestratorDir(projectPath), `rt-${type.toLowerCase()}--${safeBranch}.json`);
}

function legacyRuntimeFilePath(projectPath: string, type: RuntimeType, branch: string): string {
  const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
  return join(orchestratorDir(projectPath), `rt-${type.toLowerCase()}--${safeBranch}.json`);
}

/** Ensure all runtimes for a project are loaded into cache */
function ensureRuntimesLoaded(projectPath: string): RuntimeData[] {
  if (_runtimesLoaded.has(projectPath)) {
    return _runtimes.get(projectPath) || [];
  }

  const results: RuntimeData[] = [];

  // New location: agents/{issueId}/.10timesdev/rt-*.json
  const agentsDir = join(orchestratorDir(projectPath), "agents");
  if (existsSync(agentsDir)) {
    for (const issueId of readdirSync(agentsDir)) {
      const metaDir = join(agentsDir, issueId, ".10timesdev");
      if (!existsSync(metaDir)) continue;
      for (const f of readdirSync(metaDir)) {
        if (f.startsWith("rt-") && f.endsWith(".json")) {
          try { results.push(JSON.parse(readFileSync(join(metaDir, f), "utf-8"))); } catch {}
        }
      }
    }
  }

  // Legacy location: .10timesdev/rt-*.json (auto-migrate)
  const dir = orchestratorDir(projectPath);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.startsWith("rt-") && f.endsWith(".json")) {
        try {
          const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
          if (data.branch) {
            // Migrate: write to new location
            const p = runtimeFilePath(projectPath, data.type || "LOCAL", data.branch);
            ensureDir(dirname(p));
            writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
            try { unlinkSync(join(dir, f)); } catch {}
          }
          results.push(data);
        } catch {}
      }
    }
  }

  _runtimes.set(projectPath, results);
  _runtimesLoaded.add(projectPath);
  return results;
}

function runtimeKey(branch: string, type: RuntimeType): string {
  return `${type}:${branch}`;
}

export function getRuntime(projectPath: string, branch: string, type: RuntimeType): RuntimeData | null {
  const runtimes = ensureRuntimesLoaded(projectPath);
  return runtimes.find((r) => r.branch === branch && r.type === type) || null;
}

export function saveRuntime(projectPath: string, branch: string, type: RuntimeType, data: RuntimeData): void {
  data.updatedAt = new Date().toISOString();

  // Update cache
  const runtimes = ensureRuntimesLoaded(projectPath);
  const idx = runtimes.findIndex((r) => r.branch === branch && r.type === type);
  if (idx >= 0) {
    runtimes[idx] = data;
  } else {
    runtimes.push(data);
  }

  // Write to disk
  const p = runtimeFilePath(projectPath, type, branch);
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

export function listRuntimes(projectPath: string): RuntimeData[] {
  return ensureRuntimesLoaded(projectPath);
}

export function deleteRuntime(projectPath: string, branch: string, type: RuntimeType): void {
  // Remove from cache
  const runtimes = _runtimes.get(projectPath);
  if (runtimes) {
    const idx = runtimes.findIndex((r) => r.branch === branch && r.type === type);
    if (idx >= 0) runtimes.splice(idx, 1);
  }

  // Remove from disk
  const p = runtimeFilePath(projectPath, type, branch);
  if (existsSync(p)) unlinkSync(p);
  const lp = legacyRuntimeFilePath(projectPath, type, branch);
  if (existsSync(lp)) unlinkSync(lp);
}

// ---------------------------------------------------------------------------
// Port Allocation
// ---------------------------------------------------------------------------

export interface PortInfo {
  slot: number;
  all: number[];
  /** @deprecated use `all` */
  frontend: [number, number, number];
  /** @deprecated use `all` */
  backend: [number, number, number];
}

export function getPortsForSlot(slot: number): PortInfo {
  const nn = slot.toString().padStart(2, "0");
  const ports: number[] = [];
  for (let i = 0; i < 6; i++) {
    ports.push(parseInt(`4${nn}2${i}`));
  }
  return {
    slot,
    all: ports,
    frontend: [ports[0], ports[1], ports[2]],
    backend: [ports[3], ports[4], ports[5]],
  };
}

function getOccupiedSlots(): Set<number> {
  const occupied = new Set<number>();
  const config = getConfig();
  for (const project of config.projects) {
    for (const agent of listAgents(project.path)) {
      if (agent.portSlot !== undefined) occupied.add(agent.portSlot);
    }
    for (const rt of listRuntimes(project.path)) {
      if (rt.portSlot !== undefined) occupied.add(rt.portSlot);
    }
  }
  return occupied;
}

export function allocatePort(projectName: string, issueId: string): PortInfo {
  const config = getConfig();
  const project = config.projects.find((p) => p.name === projectName);

  if (project) {
    const agent = getAgent(project.path, issueId);
    if (agent?.portSlot !== undefined) {
      return getPortsForSlot(agent.portSlot);
    }
  }

  const occupied = getOccupiedSlots();
  let next = config.nextPortSlot || 0;
  let slot: number | null = null;

  for (let tries = 0; tries < 100; tries++) {
    if (!occupied.has(next)) {
      slot = next;
      break;
    }
    next = (next + 1) % 100;
  }

  if (slot === null) {
    throw new Error("No free port slots (100/100 occupied)");
  }

  config.nextPortSlot = (slot + 1) % 100;
  saveConfig(config);

  return getPortsForSlot(slot);
}

export function runtimeSlotId(branch: string): string {
  return `rt:${branch}`;
}

// ---------------------------------------------------------------------------
// Logs (.10timesdev/logs/{name}.log) — not cached (append-only, read rarely)
// ---------------------------------------------------------------------------

export function appendLog(projectPath: string, name: string, line: string): void {
  ensureDir(logsDir(projectPath));
  const logPath = join(logsDir(projectPath), `${name}.log`);
  const ts = new Date().toISOString();
  appendFileSync(logPath, `[${ts}] ${line}\n`, "utf-8");
}

export function readLog(projectPath: string, name: string, tail: number = 100): string {
  const logPath = join(logsDir(projectPath), `${name}.log`);
  if (!existsSync(logPath)) return "";
  const content = readFileSync(logPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  return lines.slice(-tail).join("\n");
}

/** List all log files for a given agent prefix. Returns operation names sorted by mtime (newest first). */
export function listAgentLogs(projectPath: string, issueId: string): Array<{ name: string; file: string; mtime: number }> {
  const dir = logsDir(projectPath);
  if (!existsSync(dir)) return [];
  const prefix = `agent-${issueId}-`;
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith(".log"))
      .map(f => {
        const stat = statSync(join(dir, f));
        return {
          name: f.slice(prefix.length, -4), // e.g. "spawn", "rebase", "lifecycle"
          file: f,
          mtime: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** List runtime log files for a given safe branch name. Returns entries sorted by mtime (newest first). */
export function listRuntimeLogs(projectPath: string, safeBranch: string): Array<{ name: string; file: string; mtime: number }> {
  const dir = logsDir(projectPath);
  if (!existsSync(dir)) return [];
  const prefix = `runtime-${safeBranch}`;
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith(".log"))
      .map(f => {
        const stat = statSync(join(dir, f));
        return {
          name: f.slice(0, -4), // e.g. "runtime-agent-UKR-118-guide"
          file: f,
          mtime: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Integration Config — cached via AppConfig
// ---------------------------------------------------------------------------

export function getIntegrationConfig(name: string): { enabled: boolean; config: Record<string, string> } {
  const appConfig = getConfig();
  const integ = appConfig.integrations[name];
  if (!integ) return { enabled: false, config: {} };
  return { enabled: integ.enabled, config: integ.config || {} };
}

export function saveIntegrationConfig(name: string, data: { enabled: boolean; config?: Record<string, string> }): void {
  const appConfig = getConfig();
  appConfig.integrations[name] = {
    enabled: data.enabled,
    config: data.config || appConfig.integrations[name]?.config || {},
  };
  saveConfig(appConfig);
}

export function getIntegrationConfigValue(name: string, key: string): string | null {
  const integ = getIntegrationConfig(name);
  return integ.config[key] ?? null;
}

export function setIntegrationConfigValue(name: string, key: string, value: string): void {
  const appConfig = getConfig();
  if (!appConfig.integrations[name]) {
    appConfig.integrations[name] = { enabled: true, config: {} };
  }
  if (!appConfig.integrations[name].config) {
    appConfig.integrations[name].config = {};
  }
  appConfig.integrations[name].config![key] = value;
  saveConfig(appConfig);
}

// ---------------------------------------------------------------------------
// Messages — not cached (append-only JSONL, read on demand)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "human" | "agent";
  text: string;
  ts: string;
}

function messagesFilePath(projectPath: string, issueId: string): string {
  return join(orchestratorDir(projectPath), "agents", issueId, ".10timesdev", "messages.jsonl");
}

export function appendMessage(projectPath: string, issueId: string, role: "human" | "agent", text: string): void {
  const filePath = messagesFilePath(projectPath, issueId);
  ensureDir(dirname(filePath));
  const msg: ChatMessage = { role, text, ts: new Date().toISOString() };
  appendFileSync(filePath, JSON.stringify(msg) + "\n", "utf-8");
}

export function getMessages(projectPath: string, issueId: string): ChatMessage[] {
  const filePath = messagesFilePath(projectPath, issueId);
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as ChatMessage; }
      catch { return null; }
    })
    .filter((m): m is ChatMessage => m !== null);
}

export function deleteMessage(projectPath: string, issueId: string, index: number): void {
  const messages = getMessages(projectPath, issueId);
  if (index < 0 || index >= messages.length) return;
  messages.splice(index, 1);
  const filePath = messagesFilePath(projectPath, issueId);
  writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");
}

export function rewriteTaskMdInstructions(agentDir: string, messages: ChatMessage[]): void {
  const taskMdPath = join(agentDir, ".10timesdev", "TASK.md");
  if (!existsSync(taskMdPath)) return;
  const content = readFileSync(taskMdPath, "utf-8");
  const cleaned = content.replace(/\n\n## New instructions from human\n\n[\s\S]*$/m, "");
  const humanMsgs = messages.filter((m) => m.role === "human");
  let result = cleaned;
  for (const msg of humanMsgs) {
    result += `\n\n## New instructions from human\n\n${msg.text}\n`;
  }
  writeFileSync(taskMdPath, result, "utf-8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getProjectField(projectPath: string, key: string): string | null {
  const cfg = getProjectConfig(projectPath);
  return cfg[key] ?? null;
}

export function getProjectJsonField<T>(projectPath: string, key: string): T | null {
  const val = getProjectField(projectPath, key);
  if (!val) return null;
  try {
    return JSON.parse(val) as T;
  } catch {
    return null;
  }
}
