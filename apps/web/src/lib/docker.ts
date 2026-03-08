// ---------------------------------------------------------------------------
// Docker helpers — CLI-only implementation (no dockerode).
//
// All calls use child_process (via cmd.run / cmd.dockerExec / spawn) which is
// truly async and never blocks the Node.js event loop.
//
// Previous implementation used dockerode which on Windows named pipes
// (//./pipe/docker_engine) could block the event loop indefinitely during
// streaming operations (exec.start, container.inspect, container.logs).
// ---------------------------------------------------------------------------

import { spawn } from "child_process";
import * as cmd from "./cmd";

export const DOCKER_IMAGE = "agent-orchestrator:latest";

// ---------------------------------------------------------------------------
// Image management
// ---------------------------------------------------------------------------

export async function ensureImage(): Promise<void> {
  const r = await cmd.run(`docker images -q "${DOCKER_IMAGE}"`, {
    source: "docker",
    timeout: 10_000,
  });
  if (r.ok && r.stdout.trim()) return; // image exists

  console.log(`Building Docker image ${DOCKER_IMAGE}...`);
  const result = await cmd.run(
    `docker build -t "${DOCKER_IMAGE}" -f Dockerfile.agent .`,
    { source: "docker", timeout: 300_000 },
  );
  if (!result.ok) {
    throw new Error(`Failed to build Docker image: ${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

export async function getContainerStatus(
  containerName: string,
): Promise<{ status: string; exitCode: number } | null> {
  const r = await cmd.run(
    `docker inspect --format "{{.State.Status}}|{{.State.ExitCode}}" "${containerName}"`,
    { source: "docker", timeout: 10_000 },
  );
  if (!r.ok) return null;
  const parts = r.stdout.trim().split("|");
  return {
    status: parts[0],
    exitCode: parseInt(parts[1], 10) || 0,
  };
}

export async function getContainerLogs(
  containerName: string,
  tail: number = 100,
): Promise<string> {
  const r = await cmd.run(
    `docker logs --tail ${tail} --timestamps "${containerName}" 2>&1`,
    { source: "docker", timeout: 15_000 },
  );
  return r.ok ? r.stdout : "";
}

export async function removeContainer(containerName: string): Promise<void> {
  await cmd.run(`docker rm -f "${containerName}"`, {
    source: "docker",
    timeout: 15_000,
  });
}

export async function removeVolume(volumeName: string): Promise<void> {
  await cmd.run(`docker volume rm "${volumeName}"`, {
    source: "docker",
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Container creation — replaces docker.createContainer() + container.start()
// ---------------------------------------------------------------------------

export interface CreateContainerOptions {
  image?: string;
  name: string;
  env?: string[];              // ["KEY=VALUE", ...]
  binds?: string[];            // ["host:container", ...]
  portBindings?: Record<string, Array<{ HostPort: string }>>; // {"3000/tcp": [{HostPort: "40920"}]}
  exposedPorts?: Record<string, object>;
  extraArgs?: string[];          // additional docker create flags (e.g. ["--add-host=host.docker.internal:host-gateway"])
}

/**
 * Create and start a Docker container using the CLI.
 * Replaces dockerode's docker.createContainer() + container.start().
 */
export async function createAndStartContainer(
  opts: CreateContainerOptions,
): Promise<void> {
  const args: string[] = ["docker", "create"];

  args.push("--name", opts.name);

  // Environment variables
  if (opts.env) {
    for (const e of opts.env) {
      args.push("-e", e);
    }
  }

  // Volume binds
  if (opts.binds) {
    for (const b of opts.binds) {
      args.push("-v", b);
    }
  }

  // Port bindings
  if (opts.portBindings) {
    for (const [containerPort, hostPorts] of Object.entries(opts.portBindings)) {
      for (const hp of hostPorts) {
        args.push("-p", `${hp.HostPort}:${containerPort}`);
      }
    }
  }

  // Extra args (e.g. --add-host)
  if (opts.extraArgs) {
    for (const a of opts.extraArgs) {
      args.push(a);
    }
  }

  args.push(opts.image || DOCKER_IMAGE);

  // Build the command string with proper quoting
  const createCmd = args.map(a => {
    // Don't quote the command name and simple flags
    if (a === "docker" || a === "create" || a.startsWith("-")) return a;
    // Quote everything else
    return `"${a}"`;
  }).join(" ");

  const createResult = await cmd.run(createCmd, {
    source: "docker",
    timeout: 30_000,
  });
  if (!createResult.ok) {
    throw new Error(`Failed to create container ${opts.name}: ${createResult.stderr}`);
  }

  // Start the container
  const startResult = await cmd.run(`docker start "${opts.name}"`, {
    source: "docker",
    timeout: 15_000,
  });
  if (!startResult.ok) {
    throw new Error(`Failed to start container ${opts.name}: ${startResult.stderr}`);
  }
}

/**
 * Execute a command in a running container (for setup tasks like chown).
 * Uses cmd.dockerExec for short-lived commands.
 */
export async function execInContainerSimple(
  containerName: string,
  command: string,
  opts: { user?: string; timeout?: number } = {},
): Promise<cmd.CmdResult> {
  return cmd.dockerExec(containerName, command, {
    source: "docker",
    timeout: opts.timeout ?? 10_000,
    user: opts.user,
  });
}

// ---------------------------------------------------------------------------
// Exec helpers — run commands inside a running container
// ---------------------------------------------------------------------------

export interface ExecOptions {
  user?: string;
  workingDir?: string;
  env?: string[];
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

/**
 * Run a command inside a container (attached), wait for result.
 * Uses child_process exec via cmd.run — never blocks the event loop.
 */
export async function execInContainer(
  containerName: string,
  cmdArgs: string[],
  opts: ExecOptions & { timeout?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeout ?? 30_000;

  const dockerArgs: string[] = [];
  if (opts.user) dockerArgs.push("-u", opts.user);
  if (opts.workingDir) dockerArgs.push("-w", opts.workingDir);
  if (opts.env) {
    for (const e of opts.env) {
      dockerArgs.push("-e", e);
    }
  }

  // Build the full docker exec command
  const flagStr = dockerArgs.map(a => `"${a}"`).join(" ");
  const cmdStr = cmdArgs.map(a => JSON.stringify(a)).join(" ");
  const fullCmd = `docker exec ${flagStr} "${containerName}" ${cmdStr}`;

  const r = await cmd.run(fullCmd, {
    source: "docker-exec",
    timeout: timeoutMs,
  });

  return {
    exitCode: r.code,
    output: r.stdout + (r.stderr ? "\n" + r.stderr : ""),
  };
}

/**
 * Run a command inside a container (detached background exec).
 * Uses child_process.spawn — truly async, never blocks the event loop.
 * Calls onExit callback when the process finishes.
 */
export async function execInContainerAsync(
  containerName: string,
  cmdArgs: string[],
  opts: ExecOptions & {
    onExit?: (exitCode: number, output: string) => void;
    onData?: (chunk: string) => void;
  } = {},
): Promise<{ execId: string }> {
  const args: string[] = ["exec"];

  if (opts.user) args.push("-u", opts.user);
  if (opts.workingDir) args.push("-w", opts.workingDir);
  if (opts.env) {
    for (const e of opts.env) {
      args.push("-e", e);
    }
  }

  args.push(containerName, ...cmdArgs);

  const child = spawn("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks: string[] = [];

  child.stdout?.on("data", (d: Buffer) => {
    const s = d.toString();
    chunks.push(s);
    opts.onData?.(s);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const s = d.toString();
    chunks.push(s);
    opts.onData?.(s);
  });

  child.on("close", (code) => {
    opts.onExit?.(code ?? -1, chunks.join(""));
  });

  child.on("error", (err) => {
    console.error(`[docker] spawn error for exec in ${containerName}:`, err);
    opts.onExit?.(-1, `spawn error: ${err.message}`);
  });

  // Generate a unique exec ID (no longer comes from dockerode)
  const execId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return { execId };
}

/**
 * Check if a process matching `pattern` is running inside the container.
 */
export async function isProcessRunning(
  containerName: string,
  pattern: string,
): Promise<boolean> {
  const r = await cmd.dockerExec(
    containerName,
    `ps aux | grep -E '${pattern}' | grep -v grep | grep -v ' Z ' || true`,
    { source: "docker", timeout: 10_000, user: "root" },
  );
  return r.ok && r.stdout.trim().length > 0;
}

/**
 * Kill processes matching `pattern` inside the container.
 */
export async function killProcesses(
  containerName: string,
  pattern: string,
): Promise<void> {
  // SIGTERM first, then SIGKILL after 2s to ensure process dies
  await cmd.dockerExec(
    containerName,
    `pkill -f '${pattern}' || true`,
    { source: "docker", timeout: 5_000, user: "root" },
  );
  await new Promise(r => setTimeout(r, 2000));
  await cmd.dockerExec(
    containerName,
    `pkill -9 -f '${pattern}' || true`,
    { source: "docker", timeout: 5_000, user: "root" },
  );
}
