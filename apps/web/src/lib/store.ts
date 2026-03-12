import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync, statSync } from "fs";
import { writeFile, appendFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { stateFromLegacy, deriveLegacyStatus } from "@/lib/agent-aggregate/compat";
import { deriveUiStatus } from "@/lib/agent-aggregate/types";

// ---------------------------------------------------------------------------
// Deep clone — used by getters to prevent external mutation of cached objects
// ---------------------------------------------------------------------------

function deepClone<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  return structuredClone(obj);
}

// ---------------------------------------------------------------------------
// Async Disk Writer — write-behind cache with coalescing
// ---------------------------------------------------------------------------
// Callers update in-memory cache synchronously and schedule an async disk write.
// Multiple rapid writes to the same path collapse into one I/O operation.

const _pendingWrites = new Map<string, { data: string; dir?: string }>();
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 150;

function scheduleDiskWrite(filePath: string, data: string, ensureDirPath?: string): void {
  _pendingWrites.set(filePath, { data, dir: ensureDirPath });
  if (!_flushTimer) {
    _flushTimer = setTimeout(flushWrites, FLUSH_INTERVAL_MS);
  }
}

async function flushWrites(): Promise<void> {
  _flushTimer = null;
  if (_pendingWrites.size === 0) return;

  const batch = new Map(_pendingWrites);
  _pendingWrites.clear();

  const ops: Promise<void>[] = [];
  for (const [filePath, { data, dir }] of batch) {
    ops.push(
      (async () => {
        try {
          if (dir && !existsSync(dir)) await mkdir(dir, { recursive: true });
          await writeFile(filePath, data, "utf-8");
        } catch (err) {
          // Log but don't crash — cache is already consistent
          console.error(`[store] async write failed for ${filePath}: ${err}`);
        }
      })(),
    );
  }
  await Promise.all(ops);
}

// ---------------------------------------------------------------------------
// Buffered Log Writer — batches appendLog / appendMessage calls
// ---------------------------------------------------------------------------

const _logBuffers = new Map<string, string[]>();
let _logFlushTimer: ReturnType<typeof setTimeout> | null = null;
const LOG_FLUSH_INTERVAL_MS = 200;

function bufferAppend(filePath: string, line: string, dirPath: string): void {
  let buf = _logBuffers.get(filePath);
  if (!buf) {
    buf = [];
    _logBuffers.set(filePath, buf);
  }
  buf.push(line);
  if (!_logFlushTimer) {
    _logFlushTimer = setTimeout(flushLogBuffers, LOG_FLUSH_INTERVAL_MS);
  }
}

async function flushLogBuffers(): Promise<void> {
  _logFlushTimer = null;
  if (_logBuffers.size === 0) return;

  const batch = new Map(_logBuffers);
  _logBuffers.clear();

  const ops: Promise<void>[] = [];
  for (const [filePath, lines] of batch) {
    ops.push(
      (async () => {
        try {
          const dir = dirname(filePath);
          if (!existsSync(dir)) await mkdir(dir, { recursive: true });
          await appendFile(filePath, lines.join(""), "utf-8");
        } catch (err) {
          console.error(`[store] async log flush failed for ${filePath}: ${err}`);
        }
      })(),
    );
  }
  await Promise.all(ops);
}

/** Flush all pending writes + logs immediately. Call on graceful shutdown. */
export async function flushAll(): Promise<void> {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
  await Promise.all([flushWrites(), flushLogBuffers()]);
}

// Safety net: flush on process exit
if (typeof process !== "undefined") {
  const exitFlush = () => { flushAll().catch(() => {}); };
  process.on("beforeExit", exitFlush);
  process.on("SIGTERM", () => { flushAll().then(() => process.exit(0)).catch(() => process.exit(1)); });
  process.on("SIGINT", () => { flushAll().then(() => process.exit(0)).catch(() => process.exit(1)); });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface TrackerInstance {
  id: string;
  type: string;            // "linear" | "sentry"
  name: string;            // "Team UKR", "Sentry Prod"
  isDefault: boolean;      // one default per type
  config: Record<string, string>;  // type-specific config (apiKey, teamKey, org, etc.)
}

export interface ProjectTrackerEntry {
  type: string;            // "linear" | "sentry"
  enabled: boolean;
  instanceId?: string;     // specific instance ID; undefined = use default for type
  overrides?: Record<string, string>;  // per-project overrides (label, sentryProjects, etc.)
}

export interface ProjectTrackerConfig {
  trackers: ProjectTrackerEntry[];
}

export interface AIProviderInstance {
  id: string;
  type: "claude-code" | "aider";   // provider type
  name: string;                     // "Claude Sonnet", "Aider + GPT-4o", "Local Ollama"
  isDefault: boolean;               // exactly one is system default
  config: Record<string, string>;   // model, aiderBackend, OPENAI_API_KEY, etc.
}

export interface IMProviderInstance {
  id: string;
  type: "telegram";              // extensible: "slack" | "discord" etc.
  name: string;
  isDefault: boolean;
  enabled: boolean;              // per-instance on/off toggle
  config: Record<string, string>; // botToken, chatId
}

export interface RepoProviderInstance {
  id: string;
  type: "github" | "gitlab";
  name: string;
  isDefault: boolean;
  config: Record<string, string>; // authMode, token, committerName, committerEmail
}

export interface RuntimeEnvInstance {
  id: string;
  type: "supabase" | "netlify" | "vercel";
  name: string;
  enabled: boolean;
  config: Record<string, string>; // accessToken / authToken, teamId, etc.
}

export interface AIRule {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  order: number;
  whenToUse: string;           // freetext: "When task involves React frontend", agent decides
}

export interface AppConfig {
  projects: ProjectEntry[];
  integrations: Record<string, {
    enabled: boolean;
    config?: Record<string, string>;
  }>;
  trackerInstances?: TrackerInstance[];
  aiProviderInstances?: AIProviderInstance[];
  imProviderInstances?: IMProviderInstance[];
  repoProviderInstances?: RepoProviderInstance[];
  rtenvInstances?: RuntimeEnvInstance[];
  aiRules?: AIRule[];
  nextPortSlot: number;
}

export type AgentStatus =
  | "PENDING" | "SPAWNING" | "RUNNING" | "EXITED" | "WAITING"
  | "PREVIEW" | "IN_REVIEW" | "MERGING" | "REBASING" | "DONE" | "CANCELLED" | "CLEANUP" | "REMOVED";

export interface AgentData {
  issueId: string;
  linearIssueUuid?: string;
  trackerSource?: string;       // "linear" | "sentry"
  trackerExternalId?: string;   // tracker-specific ID
  title: string;
  description?: string;
  createdBy?: string;
  issueCreatedAt?: string;
  status: AgentStatus;
  containerName?: string;
  branch?: string;
  agentDir?: string;
  portSlot?: number;
  servicesEnabled: boolean;
  spawned: boolean;
  previewed: boolean;
  notified: boolean;
  reassigned?: boolean;
  rebaseResult?: { success: boolean; steps: { cmd: string; ok: boolean; output: string }[]; error?: string; conflict?: boolean; conflictFiles?: string[] };
  createdAt: string;
  updatedAt: string;
  lastWakeCommentAt?: string;
  // AI provider instance (agent-level)
  aiProviderInstanceId?: string;
  // Aggregate state
  state?: import("@/lib/agent-aggregate/types").AgentState;
  currentOperation?: import("@/lib/agent-aggregate/types").CurrentOperation | null;
  // UI status — derived, always written on save
  uiStatus?: import("@/lib/agent-aggregate/types").UiState;
  /** Generic key-value metadata — integrations can store per-agent data here (e.g. telegram topic IDs). */
  meta?: Record<string, string>;
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

// Global config lives in .config/ at workspace root
function findWorkspaceRoot(): string {
  const fromCwd = process.cwd();
  const fromMonorepo = join(fromCwd, "..", "..");
  if (existsSync(join(fromCwd, "pnpm-workspace.yaml")) || existsSync(join(fromCwd, ".config"))) return fromCwd;
  if (existsSync(join(fromMonorepo, "pnpm-workspace.yaml")) || existsSync(join(fromMonorepo, ".config"))) return fromMonorepo;
  return fromCwd;
}

const CONFIG_DIR = join(findWorkspaceRoot(), ".config");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const SECRETS_PATH = join(CONFIG_DIR, ".env.secrets");

// ---------------------------------------------------------------------------
// Global secrets — extract sensitive fields from config.json to .env.secrets
// ---------------------------------------------------------------------------

/** Maps instance type → secret field names within instance.config */
const INSTANCE_SECRET_FIELDS: Record<string, string[]> = {
  linear: ["apiKey"],
  sentry: ["authToken"],
  telegram: ["botToken"],
  github: ["token", "defaultToken"],
  gitlab: ["token"],
  supabase: ["accessToken"],
  netlify: ["authToken"],
  vercel: ["authToken"],
  aider: ["OPENAI_API_KEY"],
};

/** Category prefixes for env key generation */
const INSTANCE_CATEGORIES: Record<string, string> = {
  trackerInstances: "TRACKER",
  imProviderInstances: "IM",
  repoProviderInstances: "REPO",
  rtenvInstances: "RTENV",
  aiProviderInstances: "AI",
};

function readSecrets(): Record<string, string> {
  if (!existsSync(SECRETS_PATH)) return {};
  const content = readFileSync(SECRETS_PATH, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    result[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
  }
  return result;
}

function writeSecrets(secrets: Record<string, string>): void {
  const lines = ["# Auto-generated — do not edit manually"];
  for (const [key, value] of Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b))) {
    if (value) lines.push(`${key}=${value}`);
  }
  // Sync — secrets must persist immediately (same reason as config.json)
  ensureDir(CONFIG_DIR);
  writeFileSync(SECRETS_PATH, lines.join("\n") + "\n", "utf-8");
}

function stripSecrets(config: AppConfig): { cleaned: AppConfig; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};

  // Instance-based sections
  for (const [section, category] of Object.entries(INSTANCE_CATEGORIES)) {
    const instances = (config as any)[section] as Array<{ id: string; type: string; config: Record<string, string> }> | undefined;
    if (!instances) continue;
    for (const inst of instances) {
      const secretFields = INSTANCE_SECRET_FIELDS[inst.type];
      if (!secretFields) continue;
      for (const field of secretFields) {
        if (inst.config[field]) {
          secrets[`${category}_${inst.type}_${inst.id}__${field}`] = inst.config[field];
          inst.config[field] = "";
        }
      }
    }
  }

  return { cleaned: config, secrets };
}

function mergeSecrets(config: AppConfig, secrets: Record<string, string>): void {
  for (const [key, value] of Object.entries(secrets)) {
    if (!value) continue;
    // Skip legacy entries — no longer supported
    if (key.startsWith("LEGACY_")) continue;

    // CATEGORY_type_id__field
    const instMatch = key.match(/^([A-Z]+)_([^_]+)_(.+)__(.+)$/);
    if (!instMatch) continue;
    const [, category, type, id, field] = instMatch;
    const section = Object.entries(INSTANCE_CATEGORIES).find(([, cat]) => cat === category)?.[0];
    if (!section) continue;
    const instances = (config as any)[section] as Array<{ id: string; type: string; config: Record<string, string> }> | undefined;
    if (!instances) continue;
    const inst = instances.find((i) => i.type === type && i.id === id);
    if (inst) inst.config[field] = value;
  }
}

function migrateSecretsIfNeeded(config: AppConfig): void {
  if (existsSync(SECRETS_PATH)) return;
  const { cleaned, secrets } = stripSecrets(deepClone(config));
  if (Object.keys(secrets).length === 0) return;
  writeSecrets(secrets);
  ensureDir(CONFIG_DIR);
  writeFileSync(CONFIG_PATH, JSON.stringify(cleaned, null, 2), "utf-8");
}

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

// Use globalThis so cache survives Next.js hot module replacement in dev mode.
// Without this, module re-evaluation creates fresh Maps while old module instances
// still reference their own (stale) Maps — causing split-brain between API routes and SSR.
function getGlobal<T>(key: string, factory: () => T): T {
  return ((globalThis as any)[key] ??= factory());
}
const _projectConfigs = getGlobal("__store_projectConfigs__", () => new Map<string, ProjectConfig>());
const _agents = getGlobal("__store_agents__", () => new Map<string, Map<string, AgentData>>());
const _agentsLoaded = getGlobal("__store_agentsLoaded__", () => new Set<string>());
const _runtimes = getGlobal("__store_runtimes__", () => new Map<string, RuntimeData[]>());
const _runtimesLoaded = getGlobal("__store_runtimesLoaded__", () => new Set<string>());

/** Force reload from disk on next access. Call from force-refresh endpoint. */
export function invalidateCache(projectPath?: string): void {
  if (projectPath) {
    _agentsLoaded.delete(projectPath);
    _agents.delete(projectPath);
    _runtimesLoaded.delete(projectPath);
    _runtimes.delete(projectPath);
    _projectConfigs.delete(projectPath);
  } else {
    _configCache.config = null;
    _configCache.mtimeMs = 0;
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

// AppConfig cache — on globalThis to survive Next.js HMR / multiple module instances.
const _configCache = getGlobal("__store_configCache__", () => ({
  config: null as AppConfig | null,
  mtimeMs: 0,
}));

export function getConfig(): AppConfig {
  // Check if config file changed on disk since our last read.
  // This is cheap (one statSync) and fixes stale cache across Next.js
  // module instances (API routes vs SSR share the same file, but not memory).
  if (_configCache.config && existsSync(CONFIG_PATH)) {
    const diskMtime = statSync(CONFIG_PATH).mtimeMs;
    if (diskMtime > _configCache.mtimeMs) {
      _configCache.config = null; // force re-read
    }
  }

  if (_configCache.config) return _configCache.config;

  if (!existsSync(CONFIG_PATH)) {
    _configCache.config = { ...DEFAULT_CONFIG };
    saveConfig(_configCache.config);
    return _configCache.config;
  }
  _configCache.mtimeMs = statSync(CONFIG_PATH).mtimeMs;
  _configCache.config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  // Auto-migrate secrets on first load
  migrateSecretsIfNeeded(_configCache.config!);
  // Merge secrets from .env.secrets into in-memory config
  const secrets = readSecrets();
  if (Object.keys(secrets).length > 0) {
    mergeSecrets(_configCache.config!, secrets);
  }
  return _configCache.config!;
}

export function saveConfig(config: AppConfig): void {
  const { cleaned, secrets } = stripSecrets(deepClone(config));
  writeSecrets(secrets);
  _configCache.config = config; // cache with secrets in-memory
  // Config.json is written synchronously — it's infrequent (project add/remove,
  // integration config changes) and must survive Next.js hot reload / module re-eval
  // where in-memory cache is lost and the file must be up to date.
  ensureDir(CONFIG_DIR);
  writeFileSync(CONFIG_PATH, JSON.stringify(cleaned, null, 2), "utf-8");
  _configCache.mtimeMs = statSync(CONFIG_PATH).mtimeMs;
}

// ---------------------------------------------------------------------------
// AI Rules (global)
// ---------------------------------------------------------------------------

export function getAIRules(): AIRule[] {
  return getConfig().aiRules || [];
}

export function saveAIRules(rules: AIRule[]): void {
  const config = getConfig();
  config.aiRules = rules;
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Project Config — cached
// ---------------------------------------------------------------------------

/** Keys that contain secrets — stored in .env.10timesdev (not committed to git) */
const SECRET_KEYS = new Set([
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
  ensureDir(dirname(filePath));
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

/** Load a single agent directory into the cache map (returns true if loaded). */
function loadAgentDir(map: Map<string, AgentData>, agentsDir: string, d: string, projectPath: string): boolean {
  const cfgPath = join(agentsDir, d, ".10timesdev", "config.json");
  if (existsSync(cfgPath)) {
    try {
      const data = JSON.parse(readFileSync(cfgPath, "utf-8")) as AgentData;
      map.set(d, data);
      return true;
    } catch {}
  } else if (existsSync(join(agentsDir, d, "git", ".git"))) {
    // New structure: git clone in git/ subdir, no config.json yet
    const now = new Date().toISOString();
    const stub: AgentData = {
      issueId: d,
      title: d,
      status: "EXITED",
      branch: `agent/${d}`,
      agentDir: join(agentsDir, d, "git"),
      servicesEnabled: false,
      spawned: false,
      previewed: false,
      notified: false,
      createdAt: now,
      updatedAt: now,
    };
    map.set(d, stub);
    const p = agentFilePath(projectPath, d);
    scheduleDiskWrite(p, JSON.stringify(stub, null, 2), dirname(p));
    return true;
  } else if (existsSync(join(agentsDir, d, ".git"))) {
    // Legacy structure: git clone at agent root
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
    scheduleDiskWrite(p, JSON.stringify(stub, null, 2), dirname(p));
    return true;
  }
  return false;
}

/**
 * Ensure all agents for a project are loaded into cache.
 * Full disk scan on first call only. After that, cache is authoritative
 * (write-through via saveAgent/cacheAgent, single-item fallback in getAgent).
 */
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
      if (d.startsWith(".")) continue;
      loadAgentDir(map, agentsDir, d, projectPath);
    }
  }

  _agents.set(projectPath, map);
  _agentsLoaded.add(projectPath);
  return map;
}

export function getAgent(projectPath: string, issueId: string): AgentData | null {
  const map = ensureAgentsLoaded(projectPath);
  let agent = map.get(issueId) || null;
  // Disk fallback: if the cache misses, check if the agent file exists on disk
  // (e.g. created by another process or the dispatcher after cache was populated)
  if (!agent) {
    const cfgPath = agentFilePath(projectPath, issueId);
    if (existsSync(cfgPath)) {
      try {
        agent = JSON.parse(readFileSync(cfgPath, "utf-8")) as AgentData;
        map.set(issueId, agent);
      } catch {}
    }
  }
  if (agent && !agent.state) {
    // Bootstrap aggregate state from legacy status on first access

    agent.state = stateFromLegacy(agent);
    agent.currentOperation = null;
  }
  if (agent && agent.state && !agent.state.trackerStatus) {
    // Migrate: trackerStatus was added after linearStatus — backfill from linearStatus
    agent.state.trackerStatus = (agent.state as any).linearStatus || "unstarted";
  }
  if (agent && agent.state && !agent.uiStatus) {

    agent.uiStatus = deriveUiStatus(agent.state, agent.currentOperation ?? null);
  }
  if (agent && !agent.issueCreatedAt && agent.createdAt) {
    agent.issueCreatedAt = agent.createdAt;
  }
  return agent ? deepClone(agent) : null;
}

/**
 * Get the raw cached agent reference (no cloning).
 * For internal use by AgentAggregate only — external code must use getAgent().
 */
export function getAgentRef(projectPath: string, issueId: string): AgentData | null {
  const map = ensureAgentsLoaded(projectPath);
  return map.get(issueId) || null;
}

/** Add agent to in-memory cache without writing to disk. Use when disk write would cause side-effects. */
export function cacheAgent(projectPath: string, issueId: string, data: AgentData): void {
  const map = ensureAgentsLoaded(projectPath);
  map.set(issueId, data);
}

export function saveAgent(projectPath: string, issueId: string, data: AgentData): void {
  // Derive statuses from aggregate state
  if (data.state) {


    data.status = deriveLegacyStatus(data.state, data.currentOperation ?? null);
    data.uiStatus = deriveUiStatus(data.state, data.currentOperation ?? null);
  }

  // Update cache (synchronous — reads see new data immediately)
  const map = ensureAgentsLoaded(projectPath);
  data.updatedAt = new Date().toISOString();
  map.set(issueId, data);

  // Async write — coalesced if multiple saves happen quickly
  const p = agentFilePath(projectPath, issueId);
  scheduleDiskWrite(p, JSON.stringify(data, null, 2), dirname(p));
}

/** Read a single meta value from an agent. */
export function getAgentMeta(projectPath: string, issueId: string, key: string): string | null {
  const agent = getAgentRef(projectPath, issueId);
  return agent?.meta?.[key] ?? null;
}

/** Write a single meta value to an agent (persists immediately). */
export function setAgentMeta(projectPath: string, issueId: string, key: string, value: string): void {
  const agent = getAgentRef(projectPath, issueId);
  if (!agent) return;
  if (!agent.meta) agent.meta = {};
  agent.meta[key] = value;
  saveAgent(projectPath, issueId, agent);
}

export function listAgents(projectPath: string): Array<AgentData & { _projectPath: string }> {
  const map = ensureAgentsLoaded(projectPath);
  // Trust write-through cache — no per-agent existsSync check.

  return Array.from(map.values()).map((agent) => {
    // Bootstrap state/uiStatus if missing (same as getAgent)
    if (!agent.state) {
  
      agent.state = stateFromLegacy(agent);
      agent.currentOperation = null;
    }
    if (agent.state && !agent.state.trackerStatus) {
      // Migrate: trackerStatus was added after linearStatus — backfill from linearStatus
      agent.state.trackerStatus = (agent.state as any).linearStatus || "unstarted";
    }
    if (!agent.uiStatus) {
  
      agent.uiStatus = deriveUiStatus(agent.state, agent.currentOperation ?? null);
    }
    if (!agent.issueCreatedAt && agent.createdAt) {
      agent.issueCreatedAt = agent.createdAt;
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
            scheduleDiskWrite(p, JSON.stringify(data, null, 2), dirname(p));
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
  const found = runtimes.find((r) => r.branch === branch && r.type === type);
  return found ? deepClone(found) : null;
}

export function saveRuntime(projectPath: string, branch: string, type: RuntimeType, data: RuntimeData): void {
  data.updatedAt = new Date().toISOString();

  // Update cache (synchronous)
  const runtimes = ensureRuntimesLoaded(projectPath);
  const idx = runtimes.findIndex((r) => r.branch === branch && r.type === type);
  if (idx >= 0) {
    runtimes[idx] = data;
  } else {
    runtimes.push(data);
  }

  // Async write
  const p = runtimeFilePath(projectPath, type, branch);
  scheduleDiskWrite(p, JSON.stringify(data, null, 2), dirname(p));
}

export function listRuntimes(projectPath: string): RuntimeData[] {
  return deepClone(ensureRuntimesLoaded(projectPath));
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
  const dir = logsDir(projectPath);
  const logPath = join(dir, `${name}.log`);
  const ts = new Date().toISOString();
  bufferAppend(logPath, `[${ts}] ${line}\n`, dir);
}

export function readLog(projectPath: string, name: string, tail: number = 100): string {
  const logPath = join(logsDir(projectPath), `${name}.log`);
  let content = "";
  if (existsSync(logPath)) {
    content = readFileSync(logPath, "utf-8");
  }
  // Include buffered (not yet flushed) lines
  const buffered = _logBuffers.get(logPath);
  if (buffered && buffered.length > 0) {
    content += buffered.join("");
  }
  if (!content) return "";
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
  return { enabled: integ.enabled, config: deepClone(integ.config || {}) };
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
// Tracker Instances — stored in AppConfig.trackerInstances
// ---------------------------------------------------------------------------

let _idCounter = 0;
function generateId(): string {
  return `ti_${Date.now().toString(36)}_${(++_idCounter).toString(36)}`;
}

export function getTrackerInstances(type?: string): TrackerInstance[] {
  const config = getConfig();
  const all = config.trackerInstances || [];
  const filtered = type ? all.filter((i) => i.type === type) : all;
  return deepClone(filtered);
}

export function getTrackerInstance(id: string): TrackerInstance | undefined {
  return getTrackerInstances().find((i) => i.id === id);
}

export function getDefaultTrackerInstance(type: string): TrackerInstance | undefined {
  const instances = getTrackerInstances(type);
  return instances.find((i) => i.isDefault) || instances[0];
}

export function saveTrackerInstance(instance: TrackerInstance): void {
  const config = getConfig();
  if (!config.trackerInstances) config.trackerInstances = [];

  // Auto-assign ID if missing
  if (!instance.id) instance.id = generateId();

  // If setting as default, unset others of same type
  if (instance.isDefault) {
    for (const i of config.trackerInstances) {
      if (i.type === instance.type && i.id !== instance.id) {
        i.isDefault = false;
      }
    }
  }

  // If first of type, force default
  const existingOfType = config.trackerInstances.filter((i) => i.type === instance.type && i.id !== instance.id);
  if (existingOfType.length === 0) instance.isDefault = true;

  const idx = config.trackerInstances.findIndex((i) => i.id === instance.id);
  if (idx >= 0) {
    config.trackerInstances[idx] = instance;
  } else {
    config.trackerInstances.push(instance);
  }

  saveConfig(config);
}

export function deleteTrackerInstance(id: string): void {
  const config = getConfig();
  if (!config.trackerInstances) return;

  const instance = config.trackerInstances.find((i) => i.id === id);
  config.trackerInstances = config.trackerInstances.filter((i) => i.id !== id);

  // If deleted was default, promote next of same type
  if (instance?.isDefault) {
    const next = config.trackerInstances.find((i) => i.type === instance.type);
    if (next) next.isDefault = true;
  }

  saveConfig(config);
}

export function getProjectTrackerConfig(projectPath: string): ProjectTrackerConfig | null {
  return getProjectJsonField<ProjectTrackerConfig>(projectPath, "TRACKER_CONFIG");
}

export function saveProjectTrackerConfig(projectPath: string, trackerConfig: ProjectTrackerConfig): void {
  const cfg = getProjectConfig(projectPath);
  cfg.TRACKER_CONFIG = JSON.stringify(trackerConfig);
  saveProjectConfig(projectPath, cfg);
}

// ---------------------------------------------------------------------------
// AI Provider Instances — stored in AppConfig.aiProviderInstances
// ---------------------------------------------------------------------------

export function getAIProviderInstances(): AIProviderInstance[] {
  const config = getConfig();
  return deepClone(config.aiProviderInstances || []);
}

export function getAIProviderInstance(id: string): AIProviderInstance | undefined {
  return getAIProviderInstances().find((i) => i.id === id);
}

export function getDefaultAIProviderInstance(): AIProviderInstance | undefined {
  const instances = getAIProviderInstances();
  return instances.find((i) => i.isDefault) || instances[0];
}

export function saveAIProviderInstance(instance: AIProviderInstance): void {
  const config = getConfig();
  if (!config.aiProviderInstances) config.aiProviderInstances = [];

  // Auto-assign ID if missing
  if (!instance.id) instance.id = generateId();

  // If setting as default, unset others
  if (instance.isDefault) {
    for (const i of config.aiProviderInstances) {
      if (i.id !== instance.id) {
        i.isDefault = false;
      }
    }
  }

  // If first instance, force default
  const existing = config.aiProviderInstances.filter((i) => i.id !== instance.id);
  if (existing.length === 0) instance.isDefault = true;

  const idx = config.aiProviderInstances.findIndex((i) => i.id === instance.id);
  if (idx >= 0) {
    config.aiProviderInstances[idx] = instance;
  } else {
    config.aiProviderInstances.push(instance);
  }

  saveConfig(config);
}

export function deleteAIProviderInstance(id: string): void {
  const config = getConfig();
  if (!config.aiProviderInstances) return;

  const instance = config.aiProviderInstances.find((i) => i.id === id);
  config.aiProviderInstances = config.aiProviderInstances.filter((i) => i.id !== id);

  // If deleted was default, promote next
  if (instance?.isDefault) {
    const next = config.aiProviderInstances[0];
    if (next) next.isDefault = true;
  }

  saveConfig(config);
}

// ---------------------------------------------------------------------------
// IM Provider Instances — stored in AppConfig.imProviderInstances
// ---------------------------------------------------------------------------

export function getIMProviderInstances(): IMProviderInstance[] {
  const config = getConfig();
  let instances = config.imProviderInstances || [];

  // Lazy migration: if no instances but legacy telegram config exists, auto-create
  if (instances.length === 0) {
    const tg = config.integrations?.telegram;
    if (tg?.config?.botToken && tg.config.botToken !== "") {
      const migrated: IMProviderInstance = {
        id: generateId(),
        type: "telegram",
        name: "Telegram Bot",
        isDefault: true,
        enabled: true,
        config: {
          botToken: tg.config.botToken,
          chatId: tg.config.chatId || "",
        },
      };
      if (!config.imProviderInstances) config.imProviderInstances = [];
      config.imProviderInstances.push(migrated);
      saveConfig(config);
      instances = config.imProviderInstances;
    }
  }

  // Backwards compat: default enabled to true for old instances
  for (const inst of instances) {
    if (inst.enabled === undefined) (inst as any).enabled = true;
  }

  return deepClone(instances);
}

export function getIMProviderInstance(id: string): IMProviderInstance | undefined {
  return getIMProviderInstances().find((i) => i.id === id);
}

export function getDefaultIMProviderInstance(): IMProviderInstance | undefined {
  const instances = getIMProviderInstances();
  return instances.find((i) => i.isDefault) || instances[0];
}

export function saveIMProviderInstance(instance: IMProviderInstance): void {
  const config = getConfig();
  if (!config.imProviderInstances) config.imProviderInstances = [];

  // Auto-assign ID if missing
  if (!instance.id) instance.id = generateId();

  // If setting as default, unset others
  if (instance.isDefault) {
    for (const i of config.imProviderInstances) {
      if (i.id !== instance.id) {
        i.isDefault = false;
      }
    }
  }

  // If first instance, force default
  const existing = config.imProviderInstances.filter((i) => i.id !== instance.id);
  if (existing.length === 0) instance.isDefault = true;

  const idx = config.imProviderInstances.findIndex((i) => i.id === instance.id);
  if (idx >= 0) {
    config.imProviderInstances[idx] = instance;
  } else {
    config.imProviderInstances.push(instance);
  }

  saveConfig(config);
}

export function deleteIMProviderInstance(id: string): void {
  const config = getConfig();
  if (!config.imProviderInstances) return;

  const instance = config.imProviderInstances.find((i) => i.id === id);
  config.imProviderInstances = config.imProviderInstances.filter((i) => i.id !== id);

  // If deleted was default, promote next
  if (instance?.isDefault) {
    const next = config.imProviderInstances[0];
    if (next) next.isDefault = true;
  }

  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Repo Provider Instances — stored in AppConfig.repoProviderInstances
// ---------------------------------------------------------------------------

export function getRepoProviderInstances(): RepoProviderInstance[] {
  const config = getConfig();
  let instances = config.repoProviderInstances || [];

  // Lazy migration: if no instances but a project has GITHUB_TOKEN, auto-create
  if (instances.length === 0) {
    for (const project of config.projects) {
      const cfg = getProjectConfig(project.path);
      if (cfg.GITHUB_TOKEN) {
        const migrated: RepoProviderInstance = {
          id: generateId(),
          type: "github",
          name: "GitHub",
          isDefault: true,
          config: {
            authMode: "token",
            token: cfg.GITHUB_TOKEN,
          },
        };
        if (!config.repoProviderInstances) config.repoProviderInstances = [];
        config.repoProviderInstances.push(migrated);
        saveConfig(config);
        instances = config.repoProviderInstances;
        break;
      }
    }
  }

  return deepClone(instances);
}

export function getRepoProviderInstance(id: string): RepoProviderInstance | undefined {
  return getRepoProviderInstances().find((i) => i.id === id);
}

export function getDefaultRepoProviderInstance(): RepoProviderInstance | undefined {
  const instances = getRepoProviderInstances();
  return instances.find((i) => i.isDefault) || instances[0];
}

export function saveRepoProviderInstance(instance: RepoProviderInstance): void {
  const config = getConfig();
  if (!config.repoProviderInstances) config.repoProviderInstances = [];

  // Auto-assign ID if missing
  if (!instance.id) instance.id = generateId();

  // If setting as default, unset others
  if (instance.isDefault) {
    for (const i of config.repoProviderInstances) {
      if (i.id !== instance.id) {
        i.isDefault = false;
      }
    }
  }

  // If first instance, force default
  const existing = config.repoProviderInstances.filter((i) => i.id !== instance.id);
  if (existing.length === 0) instance.isDefault = true;

  const idx = config.repoProviderInstances.findIndex((i) => i.id === instance.id);
  if (idx >= 0) {
    config.repoProviderInstances[idx] = instance;
  } else {
    config.repoProviderInstances.push(instance);
  }

  saveConfig(config);
}

export function deleteRepoProviderInstance(id: string): void {
  const config = getConfig();
  if (!config.repoProviderInstances) return;

  const instance = config.repoProviderInstances.find((i) => i.id === id);
  config.repoProviderInstances = config.repoProviderInstances.filter((i) => i.id !== id);

  // If deleted was default, promote next
  if (instance?.isDefault) {
    const next = config.repoProviderInstances[0];
    if (next) next.isDefault = true;
  }

  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Runtime Env Instances — stored in AppConfig.rtenvInstances
// ---------------------------------------------------------------------------

export function getRtenvInstances(): RuntimeEnvInstance[] {
  const config = getConfig();
  let instances = config.rtenvInstances || [];

  // Lazy migration: pull tokens from existing project configs
  if (instances.length === 0) {
    const projects = config.projects || [];
    for (const p of projects) {
      const cfg = getProjectConfig(p.path);
      if (cfg.SUPABASE_ACCESS_TOKEN && !instances.find((i) => i.type === "supabase")) {
        instances.push({
          id: generateId(), type: "supabase", name: "Supabase",
          enabled: true, config: { accessToken: cfg.SUPABASE_ACCESS_TOKEN },
        });
      }
      if (cfg.NETLIFY_AUTH_TOKEN && !instances.find((i) => i.type === "netlify")) {
        instances.push({
          id: generateId(), type: "netlify", name: "Netlify",
          enabled: true, config: { authToken: cfg.NETLIFY_AUTH_TOKEN },
        });
      }
    }
    if (instances.length > 0) {
      config.rtenvInstances = instances;
      saveConfig(config);
    }
  }

  // Backwards compat
  for (const inst of instances) {
    if ((inst as any).enabled === undefined) (inst as any).enabled = true;
  }

  return deepClone(instances);
}

export function getRtenvInstance(id: string): RuntimeEnvInstance | undefined {
  return getRtenvInstances().find((i) => i.id === id);
}

export function getRtenvInstancesByType(type: string): RuntimeEnvInstance[] {
  return getRtenvInstances().filter((i) => i.type === type);
}

export function saveRtenvInstance(instance: RuntimeEnvInstance): void {
  const config = getConfig();
  if (!config.rtenvInstances) config.rtenvInstances = [];

  if (!instance.id) instance.id = generateId();

  const idx = config.rtenvInstances.findIndex((i) => i.id === instance.id);
  if (idx >= 0) {
    config.rtenvInstances[idx] = instance;
  } else {
    config.rtenvInstances.push(instance);
  }

  saveConfig(config);
}

export function deleteRtenvInstance(id: string): void {
  const config = getConfig();
  if (!config.rtenvInstances) return;
  config.rtenvInstances = config.rtenvInstances.filter((i) => i.id !== id);
  saveConfig(config);
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
  const msg: ChatMessage = { role, text, ts: new Date().toISOString() };
  bufferAppend(filePath, JSON.stringify(msg) + "\n", dirname(filePath));
}

export function getMessages(projectPath: string, issueId: string): ChatMessage[] {
  const filePath = messagesFilePath(projectPath, issueId);
  let content = "";
  if (existsSync(filePath)) {
    content = readFileSync(filePath, "utf-8");
  }
  // Include buffered (not yet flushed) lines for this file
  const buffered = _logBuffers.get(filePath);
  if (buffered && buffered.length > 0) {
    content += buffered.join("");
  }
  if (!content) return [];
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
  scheduleDiskWrite(filePath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", dirname(filePath));
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
  scheduleDiskWrite(taskMdPath, result);
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
