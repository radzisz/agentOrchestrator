import { exec } from "child_process";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import _simpleGit from "simple-git";

// ---------------------------------------------------------------------------
// Unified command runner — all system calls go through here.
// Every call is logged with source, command, duration, exit code, output.
// ---------------------------------------------------------------------------

export interface CmdResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_DIR = join(process.cwd(), ".cmd-logs");
let _logReady = false;

function ensureLogDir(): void {
  if (_logReady) return;
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  _logReady = true;
}

/** Format a log line: [timestamp] [source] [level] cmd → code (ms) output */
function formatLog(
  source: string,
  level: LogLevel,
  cmd: string,
  result: CmdResult | null,
  extra?: string,
): string {
  const ts = new Date().toISOString();
  if (!result) {
    return `[${ts}] [${source}] [${level}] ${cmd}${extra ? " " + extra : ""}`;
  }
  const out = result.ok
    ? result.stdout.substring(0, 200).replace(/\n/g, "\\n")
    : result.stderr.substring(0, 300).replace(/\n/g, "\\n");
  return `[${ts}] [${source}] [${level}] ${cmd} → code=${result.code} (${result.ms}ms) ${out}`;
}

/**
 * Write to the combined log and to a per-source log file.
 * Files: .cmd-logs/all.log, .cmd-logs/{source}.log
 */
function writeLog(source: string, level: LogLevel, cmd: string, result: CmdResult | null, extra?: string): void {
  ensureLogDir();
  const line = formatLog(source, level, cmd, result, extra) + "\n";

  // Console for errors/warnings
  if (level === "error" || level === "warn") {
    console.warn(`[cmd:${source}] ${cmd} → ${result ? `code=${result.code} (${result.ms}ms)` : extra || ""}`);
  }

  // Write to files (fire-and-forget, never throw)
  try {
    appendFileSync(join(LOG_DIR, "all.log"), line, "utf-8");
    const safeSource = source.replace(/[^a-zA-Z0-9_-]/g, "_");
    appendFileSync(join(LOG_DIR, `${safeSource}.log`), line, "utf-8");
  } catch {
    // disk full, permissions — don't crash the app
  }
}

// ---------------------------------------------------------------------------
// Host command execution
// ---------------------------------------------------------------------------

/** Default env for git commands — prevent ALL interactive credential prompts.
 *  On Windows, Git Credential Manager (GCM) opens GUI dialogs unless explicitly
 *  told not to. We set every known env var to suppress popups. */
const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GCM_GUI_PROMPT: "false",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GCM_PROVIDER: "generic",
};

/**
 * simpleGit wrapper that prevents interactive credential prompts on Windows.
 * Use this instead of importing simple-git directly.
 */
export function simpleGit(basePath?: string) {
  return _simpleGit({
    baseDir: basePath || process.cwd(),
    timeout: { block: 30_000 },
  }).env({
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GCM_GUI_PROMPT: "false",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_PROVIDER: "generic",
  });
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** Source identifier for logs, e.g. "rebase:UKR-119", "monitor", "merge" */
  source: string;
}

/**
 * Run a shell command on the host. Always captures stdout + stderr.
 * Result is logged automatically.
 */
export function run(cmd: string, opts: RunOptions): Promise<CmdResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, ...opts.env };

    exec(cmd, {
      cwd: opts.cwd,
      env,
      encoding: "utf-8",
      timeout: opts.timeout || 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const ms = Date.now() - t0;
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      const result: CmdResult = {
        ok: code === 0,
        code,
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
        ms,
      };

      writeLog(opts.source, result.ok ? "debug" : "warn", cmd, result);
      resolve(result);
    });
  });
}

/**
 * Run a git command on the host. Automatically adds GIT_ENV to prevent prompts.
 */
export function git(cmd: string, opts: RunOptions): Promise<CmdResult> {
  return run(`git ${cmd}`, {
    ...opts,
    env: { ...GIT_ENV, ...opts.env },
  });
}

/**
 * Run a command inside a Docker container via `docker exec`.
 */
export function dockerExec(
  containerName: string,
  cmd: string,
  opts: RunOptions & { user?: string },
): Promise<CmdResult> {
  const userFlag = opts.user ? `-u ${opts.user}` : "";
  const fullCmd = `docker exec ${userFlag} "${containerName}" sh -c ${JSON.stringify(cmd)}`;
  return run(fullCmd, opts);
}

/**
 * Run a git command inside a Docker container.
 */
export function dockerGit(
  containerName: string,
  cmd: string,
  opts: RunOptions,
): Promise<CmdResult> {
  return dockerExec(containerName, `git ${cmd}`, opts);
}

/**
 * Run `docker ps` with filters. Returns list of container names.
 */
export async function dockerPs(
  filters: Record<string, string>,
  opts: { source: string },
): Promise<string[]> {
  const filterArgs = Object.entries(filters)
    .map(([k, v]) => `--filter "${k}=${v}"`)
    .join(" ");
  const result = await run(
    `docker ps --format "{{.Names}}" ${filterArgs}`,
    { source: opts.source, timeout: 10_000 },
  );
  if (!result.ok) return [];
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * Check if specific containers are running. Returns Set of running names.
 */
export async function getRunningContainers(opts: { source: string }): Promise<Set<string>> {
  const names = await dockerPs({ status: "running" }, opts);
  return new Set(names);
}

// ---------------------------------------------------------------------------
// Manual log entries (for Docker API calls, simpleGit, etc.)
// ---------------------------------------------------------------------------

/**
 * Log a command that was executed through a different mechanism
 * (e.g. simpleGit, Dockerode API). Call this after the operation.
 */
export function log(source: string, cmd: string, result: CmdResult): void {
  writeLog(source, result.ok ? "debug" : "warn", cmd, result);
}

/**
 * Log an info/error message without a command result.
 */
export function logInfo(source: string, msg: string): void {
  writeLog(source, "info", msg, null);
}

export function logError(source: string, msg: string): void {
  writeLog(source, "error", msg, null);
}
