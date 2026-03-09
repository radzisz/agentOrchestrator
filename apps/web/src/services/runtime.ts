import { existsSync, readFileSync, writeFileSync } from "fs";
import { execSync, spawn, ChildProcess } from "child_process";
import { simpleGit } from "@/lib/cmd";
import { join } from "path";
import * as cmd from "@/lib/cmd";
import * as store from "@/lib/store";
import {
  removeContainer,
  getContainerStatus,
  getContainerLogs,
  execInContainer,
  execInContainerAsync,
  killProcesses,
} from "@/lib/docker";
import * as portManager from "./port-manager";
import { eventBus } from "@/lib/event-bus";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";
import { linearApi } from "@orchestrator/tracker-linear";
import { resolveRtenvConfig } from "./rtenv-resolve";

// Track host-mode child processes keyed by "projectPath:branch"
const hostProcesses = new Map<string, ChildProcess[]>();

function hostKey(projectPath: string, branch: string): string {
  return `${projectPath}:${branch}`;
}

/** Kill a PID and its entire process tree (works without ChildProcess object). */
function killPidTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
    } else {
      // Try process group first, then individual PID
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
  } catch {
    // Process may already be dead — that's fine
  }
}

/** Kill a host child process and its entire process tree. */
function killHostProcess(child: ChildProcess): void {
  if (child.exitCode !== null) return; // already dead
  if (child.pid) {
    killPidTree(child.pid);
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
}

/**
 * Runtime Environment lifecycle — runs preview services inside agent container
 */

interface ServiceConfig {
  name: string;
  cmd: string;
  port: number;
  portVar?: string;
}

interface RuntimeProjectConfig {
  image?: string;
  installCmd?: string;
  buildCmd?: string;
  envVars?: string;
  services: ServiceConfig[];
}

export function getProjectRuntimeConfig(projectPath: string): RuntimeProjectConfig {
  // Try RUNTIME_CONFIG (single JSON with all fields) first
  const rtCfg = store.getProjectJsonField<{
    image?: string;
    installCmd?: string;
    buildCmd?: string;
    envVars?: string;
    services?: ServiceConfig[];
  }>(projectPath, "RUNTIME_CONFIG");

  if (rtCfg && rtCfg.services && rtCfg.services.length > 0) {
    return {
      image: rtCfg.image || "node:22-slim",
      installCmd: rtCfg.installCmd || "npm install",
      buildCmd: rtCfg.buildCmd || undefined,
      envVars: rtCfg.envVars,
      services: rtCfg.services,
    };
  }

  // Fallback: individual fields
  const runtimeImage = store.getProjectField(projectPath, "RUNTIME_IMAGE");
  const runtimeInstallCmd = store.getProjectField(projectPath, "RUNTIME_INSTALL_CMD");
  const runtimeBuildCmd = store.getProjectField(projectPath, "RUNTIME_BUILD_CMD");
  const runtimeServices = store.getProjectJsonField<ServiceConfig[]>(projectPath, "RUNTIME_SERVICES");

  if (runtimeServices && runtimeServices.length > 0) {
    return {
      image: runtimeImage || "node:22-slim",
      installCmd: runtimeInstallCmd || "npm install",
      buildCmd: runtimeBuildCmd || undefined,
      services: runtimeServices,
    };
  }
  return { image: "node:22-slim", installCmd: "npm install", services: [] };
}

/** Extract port from command string, e.g. "--port 4324" or "-p 3001", fallback to 3000+index */
export function detectPort(cmd: string, index: number): number {
  const match = cmd.match(/--port\s+(\d+)/) || cmd.match(/-p\s+(\d+)/);
  if (match) return parseInt(match[1], 10);
  return 3000 + index;
}

function safeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Kill ALL processes in the container except PID 1 (sleep infinity).
 * This is the only reliable way to clean up npm/node/astro child process trees
 * that don't respond well to pkill by pattern.
 */
async function killAllServiceProcesses(containerName: string): Promise<void> {
  try {
    await execInContainer(containerName, [
      "sh", "-c",
      "for pid in $(ps -eo pid | tail -n +2); do [ \"$pid\" -ne 1 ] && kill -9 \"$pid\" 2>/dev/null; done; true",
    ], { user: "root" });
  } catch {
    // container may not be running or exec itself was killed — that's fine
  }
}

// ---------------------------------------------------------------------------
// Port readiness check
// ---------------------------------------------------------------------------

/**
 * Check if a port is listening INSIDE the container by inspecting /proc/net/tcp.
 * We can't use host-side TCP connect because Docker proxy accepts connections
 * on mapped ports even when nothing listens inside the container.
 */
async function checkPortInContainer(containerName: string, port: number): Promise<boolean> {
  const r = await cmd.dockerExec(containerName,
    "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null",
    { source: "runtime" });
  const out = r.stdout;
  if (!out) return false;
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  return out.split("\n").some((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) return false;
    const localAddr = parts[1];
    const state = parts[3];
    return localAddr.endsWith(`:${hexPort}`) && state === "0A";
  });
}

async function waitForPorts(
  containerName: string,
  nativePorts: number[],
  timeoutSeconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const remaining = new Set(nativePorts);

  while (remaining.size > 0 && Date.now() < deadline) {
    for (const port of [...remaining]) {
      if (await checkPortInContainer(containerName, port)) {
        remaining.delete(port);
        console.log(`[runtime] Port ${port} is up inside container (${remaining.size} remaining)`);
      }
    }
    if (remaining.size > 0) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return remaining.size === 0;
}

// ---------------------------------------------------------------------------
// LOCAL runtime — runs inside agent container
// ---------------------------------------------------------------------------

export async function startLocal(
  projectName: string,
  branch: string
): Promise<string> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);
  const cfg = store.getProjectConfig(project.path);

  // Create/update runtime record
  const now = new Date().toISOString();
  let runtime = store.getRuntime(project.path, branch, "LOCAL") || {
    type: "LOCAL" as const,
    status: "STARTING" as const,
    branch,
    createdAt: now,
    updatedAt: now,
  };
  runtime.status = "STARTING";
  runtime.servicesEnabled = true;
  runtime.error = undefined;
  store.saveRuntime(project.path, branch, "LOCAL", runtime);

  const safe = safeBranchName(branch);
  const runtimeId = `LOCAL/${safe}`;

  // Find agent for this branch
  const agents = store.listAgents(project.path);
  const agent = agents.find(a =>
    a.branch === branch ||
    a.issueId === branch.replace(/^agent\//, "")
  ) || null;

  if (!agent || !agent.containerName || !agent.agentDir) {
    throw new Error(`No agent found for branch ${branch} — cannot start preview without agent container`);
  }

  // Ensure agent container is alive (recreate if dead)
  const containerOps = await import("@/lib/agent-aggregate/operations/container");
  const { stateFromLegacy } = await import("@/lib/agent-aggregate/compat");
  const tempState = agent.state || stateFromLegacy(agent);
  await containerOps.ensureContainerRunning(agent, project.path, tempState);

  const containerName = agent.containerName;
  const agentDir = agent.agentDir;
  const ports = agent.portSlot !== undefined ? store.getPortsForSlot(agent.portSlot) : null;

  if (!ports) {
    throw new Error(`Agent ${agent.issueId} has no port slot allocated`);
  }

  try {
    // Kill ALL service-related processes before rebase
    await killAllServiceProcesses(containerName);

    // Fetch + checkout the branch inside the container
    try {
      await cmd.dockerGit(containerName, `fetch origin "${branch}"`, { source: "runtime", timeout: 30000 });
      await cmd.dockerExec(containerName, `git checkout -f '${branch}' 2>/dev/null || git checkout -b '${branch}' 'origin/${branch}'`, { source: "runtime", timeout: 10000 });
      await cmd.dockerGit(containerName, `reset --hard "origin/${branch}"`, { source: "runtime", timeout: 10000 });
    } catch {
      console.warn(`[runtime] Could not fetch/checkout ${branch}, using current workspace state`);
    }

    // Copy .env if exists
    const envFile = join(project.path, ".env");
    if (existsSync(envFile)) {
      writeFileSync(join(agentDir, ".env"), readFileSync(envFile));
    }

    // Build config
    const rtCfg = getProjectRuntimeConfig(project.path);
    const installCmd = rtCfg.installCmd || "npm install";
    const buildCmd = rtCfg.buildCmd || "";
    const services = rtCfg.services.length > 0
      ? rtCfg.services.map((s, i) => ({ ...s, port: s.port || detectPort(s.cmd, i) }))
      : [{ name: "dev", cmd: detectDevScript(agentDir), port: 3000 }];

    // Map each service to its allocated host port (Docker handles port forwarding)
    const allHostPorts = ports.all;
    const rewrittenServices = services.map((svc, idx) => {
      const allocatedPort = allHostPorts[idx] || allHostPorts[0];
      return { ...svc, allocatedPort };
    });

    // Build inline startup script
    const startCmds = rewrittenServices.map((s) => s.cmd);
    const scriptParts = [
      "set -e",
      "cd /workspace",
      'export DENO_INSTALL="/usr/local"',
      'export PATH="$DENO_INSTALL/bin:$PATH"',
      'LOCK_HASH=$(md5sum package-lock.json 2>/dev/null | cut -d" " -f1 || echo "none")',
      'PREV_HASH=$(cat /workspace/node_modules/.lock-hash 2>/dev/null || echo "")',
      'if [ "$LOCK_HASH" != "$PREV_HASH" ]; then',
      `  echo "[runtime] package-lock.json changed, running: ${installCmd}"`,
      `  if ! ${installCmd}; then`,
      `    echo "[runtime] Install failed, cleaning node_modules and retrying..."`,
      `    rm -rf /workspace/node_modules`,
      `    ${installCmd}`,
      `  fi`,
      '  echo "$LOCK_HASH" > /workspace/node_modules/.lock-hash',
      "else",
      '  echo "[runtime] node_modules up to date, skipping install"',
      "fi",
    ];
    if (buildCmd) {
      scriptParts.push('BUILD_NEEDED=0');
      scriptParts.push('if [ ! -d "/workspace/packages/us_model/dist" ] || [ "$LOCK_HASH" != "$PREV_HASH" ]; then BUILD_NEEDED=1; fi');
      scriptParts.push('if [ "$BUILD_NEEDED" = "1" ]; then');
      scriptParts.push(`  echo "[runtime] Running build: ${buildCmd}"`);
      scriptParts.push(`  ${buildCmd}`);
      scriptParts.push('  echo "[runtime] Build done."');
      scriptParts.push("else");
      scriptParts.push('  echo "[runtime] Build cache valid, skipping build"');
      scriptParts.push("fi");
    }
    scriptParts.push('echo "[runtime] Starting services..."');
    scriptParts.push("set +e");
    if (startCmds.length === 1) {
      scriptParts.push(`${startCmds[0]}`);
    } else {
      for (const cmd of startCmds.slice(0, -1)) {
        scriptParts.push(`echo "[runtime] Starting: ${cmd}"`);
        scriptParts.push(`${cmd} &`);
      }
      scriptParts.push(`echo "[runtime] Starting: ${startCmds[startCmds.length - 1]}"`);
      scriptParts.push(`${startCmds[startCmds.length - 1]}`);
    }
    // Abort if runtime was stopped while we were setting up (install/build/checkout)
    const preSpawnCheck = store.getRuntime(project.path, branch, "LOCAL");
    if (preSpawnCheck && preSpawnCheck.status === "STOPPED") {
      console.log(`[runtime] Aborting startLocal for ${branch} — runtime was stopped during setup`);
      return runtimeId;
    }

    // Wrap entire script so output goes to docker logs (PID 1 stdout)
    const wrappedScript = `(${scriptParts.join("\n")}) 2>&1 | tee /proc/1/fd/1`;
    const inlineScript = wrappedScript;

    // Build env vars for the exec
    const dotEnvVars = existsSync(join(agentDir, ".env"))
      ? readEnvFile(join(agentDir, ".env"))
      : [];

    // Disable Sentry in agent previews (override .env values)
    const sentryOverrides = [
      `SENTRY_DSN=`,
      `SENTRY_AUTH_TOKEN=`,
      `SENTRY_SUPPRESS_TURBOPACK_WARNING=1`,
      `NEXT_PUBLIC_SENTRY_DSN=`,
      `SENTRY_ORG=`,
      `SENTRY_PROJECT=`,
    ];

    // Parse extra env vars from runtime config
    const configEnvVars = rtCfg.envVars
      ? rtCfg.envVars
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
      : [];

    const execEnv = [
      `PATH=/workspace/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      `PORT=${rewrittenServices[0]?.allocatedPort || 3000}`,
      `DENO_INSTALL=/usr/local`,
      // Enable polling for file watchers — inotify doesn't work on Windows Docker bind mounts
      `CHOKIDAR_USEPOLLING=1`,
      `WATCHPACK_POLLING=true`,
      ...dotEnvVars,
      ...configEnvVars,    // AFTER .env so config overrides
      ...sentryOverrides,  // AFTER everything so Sentry stays disabled
    ];

    // Launch inline script inside agent container via exec
    // Tee all output to /proc/1/fd/1 so it appears in `docker logs`
    await execInContainerAsync(containerName, [
      "sh", "-c", inlineScript,
    ], {
      user: "root",
      workingDir: "/workspace",
      env: execEnv,
      onExit: (exitCode, output) => {
        console.log(`[runtime] Preview services exited for ${branch} with code ${exitCode}`);
        if (output) {
          // Save last ~30 lines of exec output to the orchestrator log
          const tail = output.trim().split("\n").slice(-30).join("\n");
          store.appendLog(project.path, `runtime-${safeBranchName(branch)}`, `exit code=${exitCode}\n${tail}`);
        }
        const currentRuntime = store.getRuntime(project.path, branch, "LOCAL");
        if (currentRuntime && (currentRuntime.status === "RUNNING" || currentRuntime.status === "STARTING")) {
          currentRuntime.status = exitCode === 0 ? "STOPPED" : "FAILED";
          currentRuntime.error = exitCode !== 0 && output
            ? output.trim().split("\n").slice(-5).join("\n")
            : undefined;
          currentRuntime.updatedAt = new Date().toISOString();
          store.saveRuntime(project.path, branch, "LOCAL", currentRuntime);
        }
      },
    });

    // Build service → host port map
    const servicePortMap = rewrittenServices.map((svc) => ({
      name: svc.name,
      hostPort: svc.allocatedPort,
      healthPath: (svc as any).healthPath || undefined,
    }));

    // Save port map but keep STARTING — poll ports in background
    runtime.containerName = containerName;
    runtime.portSlot = ports.slot;
    runtime.servicePortMap = servicePortMap;
    store.saveRuntime(project.path, branch, "LOCAL", runtime);

    // Wait for native service ports to be listening inside container, then flip to RUNNING
    const nativePortsToCheck = services.map((s) => s.port);
    waitForPorts(containerName, nativePortsToCheck, 1800).then((allUp) => {
      const rt = store.getRuntime(project.path, branch, "LOCAL");
      if (rt && rt.status === "STARTING") {
        rt.status = allUp ? "RUNNING" : "FAILED";
        if (!allUp) rt.error = "Services did not start listening within timeout";
        rt.updatedAt = new Date().toISOString();
        store.saveRuntime(project.path, branch, "LOCAL", rt);
      }
    });

    return runtimeId;
  } catch (error) {
    runtime.status = "FAILED";
    runtime.error = String(error);
    runtime.containerName = containerName;
    store.saveRuntime(project.path, branch, "LOCAL", runtime);
    throw error;
  }
}

/** Find a free TCP port by letting the OS assign one. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Replace %VAR% placeholders in a command string with values from a map. */
function substituteVars(cmd: string, vars: Record<string, string>): string {
  return cmd.replace(/%([A-Z_][A-Z0-9_]*)%/g, (match, name) => {
    return vars[name] !== undefined ? vars[name] : match;
  });
}

// ---------------------------------------------------------------------------
// LOCAL HOST runtime — runs directly on the host machine
// ---------------------------------------------------------------------------

export async function startLocalHost(
  projectName: string,
  branch: string
): Promise<string> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const now = new Date().toISOString();
  let runtime = store.getRuntime(project.path, branch, "LOCAL") || {
    type: "LOCAL" as const,
    status: "STARTING" as const,
    branch,
    mode: "host" as const,
    createdAt: now,
    updatedAt: now,
  };
  runtime.status = "STARTING";
  runtime.mode = "host";
  runtime.servicesEnabled = true;
  runtime.error = undefined;
  store.saveRuntime(project.path, branch, "LOCAL", runtime);

  const safe = safeBranchName(branch);
  const runtimeId = `LOCAL/${safe}`;

  // Find agent for this branch
  const agents = store.listAgents(project.path);
  const agent = agents.find(a =>
    a.branch === branch ||
    a.issueId === branch.replace(/^agent\//, "")
  ) || null;

  if (!agent || !agent.agentDir) {
    throw new Error(`No agent found for branch ${branch} — cannot start host preview without agentDir`);
  }

  const agentDir = agent.agentDir;
  const ports = agent.portSlot !== undefined ? store.getPortsForSlot(agent.portSlot) : null;

  const logName = `runtime-${safe}`;
  const hk = hostKey(project.path, branch);

  try {
    // Kill any previously tracked host processes
    const prev = hostProcesses.get(hk);
    if (prev) {
      for (const p of prev) { killHostProcess(p); }
      hostProcesses.delete(hk);
    }

    // Checkout branch in agentDir via simple-git
    try {
      const git = simpleGit(agentDir);
      await git.fetch("origin", branch);
      await git.checkout(branch);
      await git.reset(["--hard", `origin/${branch}`]);
    } catch {
      console.warn(`[runtime-host] Could not fetch/checkout ${branch} in ${agentDir}, using current workspace state`);
    }

    // Copy .env if exists
    const envFile = join(project.path, ".env");
    if (existsSync(envFile)) {
      writeFileSync(join(agentDir, ".env"), readFileSync(envFile));
    }

    // Build config
    const rtCfg = getProjectRuntimeConfig(project.path);
    const installCmd = rtCfg.installCmd || "npm install";
    const services = rtCfg.services.length > 0
      ? rtCfg.services.map((s, i) => ({ ...s, port: s.port || detectPort(s.cmd, i) }))
      : [{ name: "dev", cmd: detectDevScript(agentDir), port: 3000 }];

    // Determine if any service uses portVar (new declarative port system)
    const hasPortVars = services.some(s => s.portVar);

    // Allocate ports: portVar services get free ports, others use slot-based ports
    const portVarValues: Record<string, string> = {};
    const rewrittenServices: Array<typeof services[0] & { allocatedPort: number }> = [];

    if (hasPortVars) {
      // New portVar system: find free ports for each service
      for (const svc of services) {
        const allocatedPort = svc.portVar ? await findFreePort() : (svc.port || 3000);
        if (svc.portVar) {
          portVarValues[svc.portVar] = String(allocatedPort);
        }
        // Substitute %VAR% placeholders in the command
        const cmd = substituteVars(svc.cmd, portVarValues);
        rewrittenServices.push({ ...svc, cmd, allocatedPort });
      }
    } else {
      // Legacy slot-based port system
      if (!ports) {
        throw new Error(`Agent ${agent.issueId} has no port slot allocated`);
      }
      const allHostPorts = ports.all;
      for (let idx = 0; idx < services.length; idx++) {
        const svc = services[idx];
        const allocatedPort = allHostPorts[idx] || allHostPorts[0];
        let cmd = svc.cmd;
        if (svc.port && svc.port !== allocatedPort) {
          cmd = cmd.replace(new RegExp(`\\b${svc.port}\\b`, "g"), String(allocatedPort));
        }
        if (!cmd.includes("--port") && !cmd.includes("-p ")) {
          cmd += ` --port ${allocatedPort}`;
        }
        rewrittenServices.push({ ...svc, cmd, allocatedPort });
      }
    }

    // Run install command
    store.appendLog(project.path, logName, `Running install: ${installCmd}`);
    try {
      execSync(installCmd, { cwd: agentDir, stdio: "pipe", timeout: 300000 });
      store.appendLog(project.path, logName, "Install completed");
    } catch (err: any) {
      store.appendLog(project.path, logName, `Install failed: ${err.message}`);
      throw new Error(`Install failed: ${err.message}`);
    }

    // Run build command (e.g. build shared packages before starting services)
    const buildCmd = rtCfg.buildCmd;
    if (buildCmd) {
      store.appendLog(project.path, logName, `Running build: ${buildCmd}`);
      try {
        execSync(buildCmd, { cwd: agentDir, stdio: "pipe", timeout: 300000 });
        store.appendLog(project.path, logName, "Build completed");
      } catch (err: any) {
        store.appendLog(project.path, logName, `Build failed: ${err.message}`);
        throw new Error(`Build failed: ${err.message}`);
      }
    }

    // Build env vars
    const envVars: Record<string, string> = {
      PORT: String(rewrittenServices[0]?.allocatedPort || 3000),
    };

    // .env vars
    if (existsSync(join(agentDir, ".env"))) {
      for (const line of readEnvFile(join(agentDir, ".env"))) {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          envVars[line.substring(0, eqIdx)] = line.substring(eqIdx + 1);
        }
      }
    }

    // Config env vars
    if (rtCfg.envVars) {
      for (const line of rtCfg.envVars.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))) {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          envVars[line.substring(0, eqIdx)] = line.substring(eqIdx + 1);
        }
      }
    }

    // Add portVar values to env so services can read them
    for (const [key, val] of Object.entries(portVarValues)) {
      envVars[key] = val;
    }

    // Disable Sentry
    envVars["SENTRY_DSN"] = "";
    envVars["SENTRY_AUTH_TOKEN"] = "";
    envVars["SENTRY_SUPPRESS_TURBOPACK_WARNING"] = "1";
    envVars["NEXT_PUBLIC_SENTRY_DSN"] = "";
    envVars["SENTRY_ORG"] = "";
    envVars["SENTRY_PROJECT"] = "";

    // Prevent dev servers from auto-opening browser tabs
    envVars["BROWSER"] = "none";           // React/Next/Vite/CRA
    envVars["OPEN_BROWSER"] = "false";     // Netlify Dev
    envVars["ASTRO_TELEMETRY_DISABLED"] = "1";

    const spawnEnv = { ...process.env, ...envVars };

    // Abort if runtime was stopped while we were setting up (install/build/checkout)
    const preSpawnCheck = store.getRuntime(project.path, branch, "LOCAL");
    if (preSpawnCheck && preSpawnCheck.status === "STOPPED") {
      console.log(`[runtime-host] Aborting startLocalHost for ${branch} — runtime was stopped during setup`);
      return runtimeId;
    }

    // Spawn each service
    const children: ChildProcess[] = [];
    for (const svc of rewrittenServices) {
      const svcEnv = { ...spawnEnv, PORT: String(svc.allocatedPort) };
      const svcLogName = `runtime-${safe}-${svc.name}`;
      store.appendLog(project.path, logName, `Starting service "${svc.name}": ${svc.cmd} (port ${svc.allocatedPort})`);

      const isWin = process.platform === "win32";
      const child = spawn(isWin ? "cmd" : "sh", isWin ? ["/c", svc.cmd] : ["-c", svc.cmd], {
        cwd: agentDir,
        env: svcEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWin, // Unix: new process group so we can kill the tree
      });

      child.stdout?.on("data", (data: Buffer) => {
        store.appendLog(project.path, svcLogName, data.toString().trimEnd());
      });
      child.stderr?.on("data", (data: Buffer) => {
        store.appendLog(project.path, svcLogName, data.toString().trimEnd());
      });

      child.on("exit", (code) => {
        store.appendLog(project.path, svcLogName, `exited with code ${code}`);
        const currentRuntime = store.getRuntime(project.path, branch, "LOCAL");
        if (!currentRuntime || (currentRuntime.status !== "RUNNING" && currentRuntime.status !== "STARTING")) return;

        const tracked = hostProcesses.get(hk);
        const allDead = tracked ? tracked.every(c => c.exitCode !== null) : true;

        if (code !== 0) {
          // Any non-zero exit → immediately mark FAILED
          currentRuntime.status = "FAILED";
          currentRuntime.error = `Service "${svc.name}" exited with code ${code}`;
          currentRuntime.updatedAt = new Date().toISOString();
          store.saveRuntime(project.path, branch, "LOCAL", currentRuntime);
        } else if (allDead) {
          // All exited cleanly → STOPPED
          currentRuntime.status = "STOPPED";
          currentRuntime.updatedAt = new Date().toISOString();
          store.saveRuntime(project.path, branch, "LOCAL", currentRuntime);
        }
      });

      children.push(child);
    }

    hostProcesses.set(hk, children);

    // Build service → host port map (include portVar name for UI display)
    const servicePortMap = rewrittenServices.map((svc) => ({
      name: svc.name,
      hostPort: svc.allocatedPort,
      healthPath: (svc as any).healthPath || undefined,
      portVar: svc.portVar || undefined,
    }));

    runtime.servicePortMap = servicePortMap;
    runtime.portSlot = ports?.slot;
    // Persist PIDs so stop works even after server restart
    runtime.hostPids = children.map(c => c.pid).filter((p): p is number => p !== undefined);
    store.saveRuntime(project.path, branch, "LOCAL", runtime);

    // Wait for ports to be listening on the host
    const portsToCheck = rewrittenServices.map(s => s.allocatedPort);
    waitForHostPorts(portsToCheck, 60).then(async (allUp) => {
      const rt = store.getRuntime(project.path, branch, "LOCAL");
      if (rt && rt.status === "STARTING") {
        rt.status = allUp ? "RUNNING" : "FAILED";
        if (!allUp) rt.error = "Services did not start listening within timeout";
        rt.updatedAt = new Date().toISOString();
        store.saveRuntime(project.path, branch, "LOCAL", rt);
      }

      // Notify IM + tracker when preview is ready
      if (allUp && agent) {
        const issueId = agent.issueId;
        const urls = rewrittenServices.map(s => `**${s.name}**: http://localhost:${s.allocatedPort}`);

        // Emit event for IM (Telegram picks this up)
        eventBus.emit("agent:preview", {
          agentId: issueId,
          issueId,
          previewUrl: urls.join(" , "),
        });

        // Add tracker comment
        try {
          const linearCfg = resolveTrackerConfig(project.path, "linear");
          if (agent.linearIssueUuid && linearCfg?.apiKey) {
            const comment = [
              `## 🖥 Local Preview`,
              ``,
              ...urls.map(u => `- ${u}`),
              ``,
              `Host mode — dostępne na localhost`,
            ].join("\n");
            await linearApi.addComment(linearCfg.apiKey, agent.linearIssueUuid, comment);
          }
        } catch (err) {
          console.error(`[runtime-host] Failed to post tracker comment: ${err}`);
        }
      }
    });

    return runtimeId;
  } catch (error) {
    runtime.status = "FAILED";
    runtime.error = String(error);
    runtime.mode = "host";
    store.saveRuntime(project.path, branch, "LOCAL", runtime);
    throw error;
  }
}

/** Check if a TCP port is listening on localhost. */
async function checkHostPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require("net");
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, "127.0.0.1");
  });
}

async function waitForHostPorts(ports: number[], timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const remaining = new Set(ports);

  while (remaining.size > 0 && Date.now() < deadline) {
    for (const port of [...remaining]) {
      if (await checkHostPort(port)) {
        remaining.delete(port);
        console.log(`[runtime-host] Port ${port} is up (${remaining.size} remaining)`);
      }
    }
    if (remaining.size > 0) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return remaining.size === 0;
}

// ---------------------------------------------------------------------------
// REMOTE runtime
// ---------------------------------------------------------------------------

interface OpLogEntry {
  ts: string;
  msg: string;
  ok: boolean;
}

function logEntry(msg: string, ok: boolean): OpLogEntry {
  return { ts: new Date().toISOString(), msg, ok };
}

export async function startRemote(
  projectName: string,
  branch: string
): Promise<string> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const rtenv = resolveRtenvConfig(project.path);

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const safe = safeBranchName(branch);
  const runtimeId = `REMOTE/${safe}`;

  const now = new Date().toISOString();
  const runtime: store.RuntimeData = store.getRuntime(project.path, branch, "REMOTE") || {
    type: "REMOTE",
    status: "STARTING",
    branch,
    createdAt: now,
    updatedAt: now,
  };
  runtime.status = "STARTING";
  runtime.error = undefined;
  runtime.expiresAt = expiresAt;
  runtime.operationLog = [];
  runtime.netlifyDeployIds = undefined;
  store.saveRuntime(project.path, branch, "REMOTE", runtime);

  const opLog: OpLogEntry[] = [];

  try {
    const safeBranch = branch.replace("/", "-").toLowerCase();
    let previewUrl: string | undefined;
    let supabaseUrl: string | undefined;
    let supabaseBranchId: string | undefined;
    const netlifyDeploys: Array<{ siteName: string; deployId: string }> = [];
    const errors: string[] = [];

    const supabaseAccessToken = rtenv.supabase?.accessToken;
    const supabaseProjectRef = rtenv.supabase?.projectRef;

    // Supabase branch
    if (supabaseAccessToken && supabaseProjectRef) {
      opLog.push(logEntry("Listing Supabase branches...", true));
      runtime.operationLog = opLog;
      store.saveRuntime(project.path, branch, "REMOTE", runtime);

      const listResp = await fetch(
        `https://api.supabase.com/v1/projects/${supabaseProjectRef}/branches`,
        { headers: { Authorization: `Bearer ${supabaseAccessToken}` } }
      );
      const existing = await listResp.json();
      const found = Array.isArray(existing)
        ? existing.find((b: any) => b.name === branch)
        : null;

      if (found) {
        supabaseBranchId = found.id;
        opLog.push(logEntry(`Supabase branch already exists (${found.id})`, true));
      } else {
        opLog.push(logEntry("Creating Supabase branch...", true));
        runtime.operationLog = opLog;
        store.saveRuntime(project.path, branch, "REMOTE", runtime);

        // Supabase needs the git branch to exist on GitHub for migration detection
        // Ensure the branch is pushed before creating the Supabase branch
        const gitBranch = branch;
        try {
          await simpleGit(project.path).fetch("origin", gitBranch);
          opLog.push(logEntry(`Verified git branch "${gitBranch}" exists on origin`, true));
        } catch {
          opLog.push(logEntry(`Warning: git branch "${gitBranch}" may not exist on origin — migrations may not run`, false));
        }
        runtime.operationLog = opLog;
        store.saveRuntime(project.path, branch, "REMOTE", runtime);

        const createResp = await fetch(
          `https://api.supabase.com/v1/projects/${supabaseProjectRef}/branches`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${supabaseAccessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ branch_name: branch, git_branch: gitBranch }),
          }
        );
        const result = await createResp.json();
        if (createResp.ok && result.id) {
          supabaseBranchId = result.id;
          opLog.push(logEntry(`Supabase branch created (id=${result.id}, git_branch=${gitBranch})`, true));
        } else {
          const errMsg = `Supabase branch creation failed: ${JSON.stringify(result)}`;
          opLog.push(logEntry(errMsg, false));
          errors.push(errMsg);
        }
      }
      runtime.operationLog = opLog;
      store.saveRuntime(project.path, branch, "REMOTE", runtime);

      if (supabaseBranchId) {
        opLog.push(logEntry("Waiting for Supabase branch to provision (up to 3 min)...", true));
        runtime.operationLog = opLog;
        store.saveRuntime(project.path, branch, "REMOTE", runtime);

        let branchInfo: any = null;
        // 36 attempts × 5s = 3 minutes (Supabase needs time for migrations)
        for (let attempt = 0; attempt < 36; attempt++) {
          const infoResp = await fetch(
            `https://api.supabase.com/v1/branches/${supabaseBranchId}`,
            { headers: { Authorization: `Bearer ${supabaseAccessToken}` } }
          );
          branchInfo = await infoResp.json();
          const status: string = branchInfo.status || "";

          // Log every 4th poll so UI shows progress
          if (attempt % 4 === 0 && attempt > 0) {
            opLog.push(logEntry(`Supabase branch status: ${status} (attempt ${attempt + 1}/36)`, true));
            runtime.operationLog = opLog;
            store.saveRuntime(project.path, branch, "REMOTE", runtime);
          }

          if (status.includes("HEALTHY") || status.includes("ACTIVE") || status === "RUNNING_MIGRATIONS_COMPLETE") break;
          if (status.includes("FAILED") || status.includes("INACTIVE")) {
            opLog.push(logEntry(`Supabase branch failed with status: ${status}`, false));
            if (branchInfo.error) opLog.push(logEntry(`Error: ${branchInfo.error}`, false));
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
        }

        const branchStatus: string = branchInfo?.status || "unknown";
        const isReady = branchStatus.includes("HEALTHY") || branchStatus.includes("ACTIVE") || branchStatus === "RUNNING_MIGRATIONS_COMPLETE";
        supabaseUrl = branchInfo?.db_host || (branchInfo?.ref ? `${branchInfo.ref}.supabase.co` : undefined);

        opLog.push(logEntry(
          `Supabase branch final status: ${branchStatus}` +
          (supabaseUrl ? ` — db_host: ${supabaseUrl}` : " — no db_host yet") +
          (branchInfo?.ref ? ` — ref: ${branchInfo.ref}` : ""),
          isReady
        ));
        runtime.operationLog = opLog;
        store.saveRuntime(project.path, branch, "REMOTE", runtime);
      }
    }

    // Netlify
    const netlifySites = rtenv.netlify?.sites || [];
    const netlifyAuthToken = rtenv.netlify?.authToken;

    if (netlifySites.length > 0 && netlifyAuthToken) {
      const netlifyHeaders = {
        Authorization: `Bearer ${netlifyAuthToken}`,
        "Content-Type": "application/json",
      };

      const previewUrls: string[] = [];

      for (const netlifySite of netlifySites) {
        opLog.push(logEntry(`Resolving Netlify site: ${netlifySite.siteName}...`, true));
        runtime.operationLog = opLog;
        store.saveRuntime(project.path, branch, "REMOTE", runtime);

        const siteResp = await fetch(
          `https://api.netlify.com/api/v1/sites/${netlifySite.siteName}.netlify.app`,
          { headers: netlifyHeaders }
        );
        const site = await siteResp.json();
        const siteId = site.id;

        if (siteId && supabaseUrl) {
          const branchDbUrl = `https://${supabaseUrl}`;
          const envVar = {
            key: "SUPABASE_DATABASE_URL",
            scopes: ["builds", "functions"],
            values: [
              {
                value: branchDbUrl,
                context: "branch-deploy",
                context_parameter: branch,
              },
            ],
          };

          const patchResp = await fetch(
            `https://api.netlify.com/api/v1/accounts/${site.account_id}/env/${envVar.key}`,
            {
              method: "PATCH",
              headers: netlifyHeaders,
              body: JSON.stringify({
                scopes: envVar.scopes,
                values: envVar.values,
              }),
            }
          );
          if (!patchResp.ok) {
            await fetch(
              `https://api.netlify.com/api/v1/accounts/${site.account_id}/env`,
              {
                method: "POST",
                headers: netlifyHeaders,
                body: JSON.stringify([envVar]),
              }
            );
          }
          opLog.push(logEntry(`Set SUPABASE_DATABASE_URL on ${netlifySite.siteName}`, true));

          opLog.push(logEntry(`Triggering deploy for ${netlifySite.siteName}...`, true));
          runtime.operationLog = opLog;
          store.saveRuntime(project.path, branch, "REMOTE", runtime);

          const buildResp = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/builds`, {
            method: "POST",
            headers: netlifyHeaders,
            body: JSON.stringify({ branch }),
          });
          const buildResult = await buildResp.json();

          if (buildResp.ok && buildResult.deploy_id) {
            netlifyDeploys.push({ siteName: netlifySite.siteName, deployId: buildResult.deploy_id });
            opLog.push(logEntry(`Deploy triggered for ${netlifySite.siteName} (${buildResult.deploy_id})`, true));
          } else {
            const errMsg = `Deploy trigger failed for ${netlifySite.siteName}: ${JSON.stringify(buildResult)}`;
            opLog.push(logEntry(errMsg, false));
            errors.push(errMsg);
          }
        } else if (siteId) {
          opLog.push(logEntry(`Triggering deploy for ${netlifySite.siteName}...`, true));
          runtime.operationLog = opLog;
          store.saveRuntime(project.path, branch, "REMOTE", runtime);

          const buildResp = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/builds`, {
            method: "POST",
            headers: netlifyHeaders,
            body: JSON.stringify({ branch }),
          });
          const buildResult = await buildResp.json();

          if (buildResp.ok && buildResult.deploy_id) {
            netlifyDeploys.push({ siteName: netlifySite.siteName, deployId: buildResult.deploy_id });
            opLog.push(logEntry(`Deploy triggered for ${netlifySite.siteName} (${buildResult.deploy_id})`, true));
          } else {
            const errMsg = `Deploy trigger failed for ${netlifySite.siteName}: ${JSON.stringify(buildResult)}`;
            opLog.push(logEntry(errMsg, false));
            errors.push(errMsg);
          }
        }

        previewUrls.push(`https://${safeBranch}--${netlifySite.siteName}.netlify.app`);
      }

      previewUrl = previewUrls.join(" , ");
    } else if (netlifySites.length > 0) {
      previewUrl = netlifySites
        .map((s) => `https://${safeBranch}--${s.siteName}.netlify.app`)
        .join(" , ");
      opLog.push(logEntry("No Netlify auth token — skipping deploy triggers", false));
    }

    const hasPendingWork = netlifyDeploys.length > 0 || (supabaseBranchId && !supabaseUrl);
    const finalStatus = errors.length > 0 ? "FAILED" : hasPendingWork ? "DEPLOYING" : "RUNNING";

    opLog.push(logEntry(`All operations complete — status: ${finalStatus}`, errors.length === 0));

    runtime.status = finalStatus as store.RuntimeStatus;
    runtime.error = errors.length > 0 ? errors.join("; ") : undefined;
    runtime.previewUrl = previewUrl;
    runtime.supabaseUrl = supabaseUrl;
    runtime.supabaseBranchId = supabaseBranchId;
    runtime.netlifyDeployIds = netlifyDeploys.length > 0 ? netlifyDeploys : undefined;
    runtime.operationLog = opLog;
    store.saveRuntime(project.path, branch, "REMOTE", runtime);

    // Notify IM + tracker comment on successful remote preview start
    if (finalStatus !== "FAILED") {
      try {
        const agent = store.listAgents(project.path).find((a) => a.branch === branch);
        const issueId = agent?.issueId;

        const urls: string[] = [];
        if (previewUrl) urls.push(`**app**: ${previewUrl}`);
        if (supabaseUrl) urls.push(`**Supabase**: \`${supabaseUrl}\``);

        if (issueId) {
          eventBus.emit("agent:preview", {
            agentId: issueId,
            issueId,
            previewUrl,
            supabaseUrl,
          });
        }

        if (agent?.linearIssueUuid && urls.length > 0) {
          const linearConfig = resolveTrackerConfig(project.path, "linear");
          if (linearConfig?.apiKey) {
            const expiresFormatted = runtime.expiresAt
              ? new Date(runtime.expiresAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })
              : "24h";
            const comment = [
              `## 🌐 Remote Preview`,
              ``,
              ...urls.map((u) => `- ${u}`),
              ``,
              `⏱ **Dostępne do**: ${expiresFormatted}`,
            ].join("\n");
            await linearApi.addComment(linearConfig.apiKey, agent.linearIssueUuid, comment);
          }
        }
      } catch (notifyErr) {
        console.log(`[runtime] Remote preview notification failed: ${notifyErr}`);
      }
    }

    return runtimeId;
  } catch (error) {
    opLog.push(logEntry(`Fatal error: ${String(error)}`, false));
    runtime.status = "FAILED";
    runtime.error = String(error);
    runtime.operationLog = opLog;
    store.saveRuntime(project.path, branch, "REMOTE", runtime);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Remote status checking
// ---------------------------------------------------------------------------

interface DeployStatus {
  siteName: string;
  state: string;
  url?: string;
  error?: string;
}

interface RemoteStatusResult {
  supabase: { status: string; error?: string } | null;
  deploys: DeployStatus[];
  allReady: boolean;
  anyFailed: boolean;
}

export async function checkRemoteStatus(projectName: string, branch: string): Promise<RemoteStatusResult> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const runtime = store.getRuntime(project.path, branch, "REMOTE");
  if (!runtime) throw new Error(`Runtime not found: REMOTE/${branch}`);

  const rtenv = resolveRtenvConfig(project.path);
  const opLog = runtime.operationLog || [];

  const result: RemoteStatusResult = {
    supabase: null,
    deploys: [],
    allReady: true,
    anyFailed: false,
  };

  // Check Supabase
  if (runtime.supabaseBranchId && rtenv.supabase?.accessToken) {
    try {
      const resp = await fetch(
        `https://api.supabase.com/v1/branches/${runtime.supabaseBranchId}`,
        { headers: { Authorization: `Bearer ${rtenv.supabase.accessToken}` } }
      );
      const info = await resp.json();
      const status: string = info.status || "unknown";
      const isHealthy = status.includes("HEALTHY") || status.includes("ACTIVE");
      const isFailed = status.includes("FAILED") || status.includes("INACTIVE");

      result.supabase = { status: isHealthy ? "active" : isFailed ? "failed" : "provisioning" };

      if (isFailed) {
        result.anyFailed = true;
        result.allReady = false;
        result.supabase.error = `Supabase branch status: ${status}`;
      } else if (!isHealthy) {
        result.allReady = false;
      }

      if (info.db_host && !runtime.supabaseUrl) {
        runtime.supabaseUrl = info.db_host;
        store.saveRuntime(project.path, branch, "REMOTE", runtime);
      }
    } catch (err) {
      result.supabase = { status: "unknown", error: String(err) };
      result.allReady = false;
    }
  }

  // Check Netlify
  const netlifyDeploys = runtime.netlifyDeployIds || [];
  if (netlifyDeploys.length > 0 && rtenv.netlify?.authToken) {
    for (const deploy of netlifyDeploys) {
      try {
        const resp = await fetch(
          `https://api.netlify.com/api/v1/deploys/${deploy.deployId}`,
          { headers: { Authorization: `Bearer ${rtenv.netlify.authToken}` } }
        );
        const info = await resp.json();
        const state = info.state || "unknown";

        const deployStatus: DeployStatus = { siteName: deploy.siteName, state, url: info.ssl_url || info.deploy_ssl_url };
        if (state === "error") {
          deployStatus.error = info.error_message || "Deploy failed";
          result.anyFailed = true;
          result.allReady = false;
        } else if (state !== "ready") {
          result.allReady = false;
        }
        result.deploys.push(deployStatus);
      } catch (err) {
        result.deploys.push({ siteName: deploy.siteName, state: "unknown", error: String(err) });
        result.allReady = false;
      }
    }
  }

  if (netlifyDeploys.length === 0 && !runtime.supabaseBranchId) {
    result.allReady = true;
  }

  // Update runtime status
  if (result.anyFailed) {
    const errors = [
      result.supabase?.error,
      ...result.deploys.filter(d => d.error).map(d => `${d.siteName}: ${d.error}`),
    ].filter(Boolean).join("; ");
    opLog.push(logEntry(`Status check: FAILED — ${errors}`, false));
    runtime.status = "FAILED";
    runtime.error = errors;
    runtime.operationLog = opLog;
    store.saveRuntime(project.path, branch, "REMOTE", runtime);
  } else if (result.allReady) {
    opLog.push(logEntry("All services ready — status: RUNNING", true));
    runtime.status = "RUNNING";
    runtime.operationLog = opLog;
    store.saveRuntime(project.path, branch, "REMOTE", runtime);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stop / Cleanup / Logs
// ---------------------------------------------------------------------------

export async function stopRuntime(projectName: string, branch: string, type: store.RuntimeType): Promise<string[]> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const runtime = store.getRuntime(project.path, branch, type);
  if (!runtime) throw new Error(`Runtime not found: ${type}/${branch}`);

  const log: string[] = [];

  if (type === "LOCAL" && runtime.mode === "host") {
    // 1) Try in-memory tracked processes
    const hk = hostKey(project.path, branch);
    const children = hostProcesses.get(hk);
    if (children) {
      log.push(`Killing ${children.length} host process(es) from memory...`);
      for (const child of children) { killHostProcess(child); }
      hostProcesses.delete(hk);
      log.push("Host processes killed.");
    }
    // 2) Fallback: kill by persisted PIDs (survives server restart / hot-reload)
    if (runtime.hostPids && runtime.hostPids.length > 0) {
      log.push(`Killing ${runtime.hostPids.length} host PID(s) from disk: ${runtime.hostPids.join(", ")}...`);
      for (const pid of runtime.hostPids) { killPidTree(pid); }
      runtime.hostPids = undefined;
      log.push("Host PIDs killed.");
    }
    log.push("Port slot freed.");
  } else if (type === "LOCAL") {
    // Find container name — runtime record or agent record
    const containerName = runtime.containerName || (() => {
      const agents = store.listAgents(project.path);
      const agent = agents.find(a => a.branch === branch);
      return agent?.containerName;
    })();
    if (containerName) {
      log.push(`Killing preview processes in ${containerName}...`);
      await killAllServiceProcesses(containerName);
      log.push("Preview processes killed (container still alive).");
    }
    log.push("Port slot freed.");
  }

  if (type === "REMOTE") {
    const rtenv = resolveRtenvConfig(project.path);
    if (runtime.supabaseBranchId && rtenv.supabase?.accessToken) {
      log.push(`Deleting Supabase branch ${runtime.supabaseBranchId}...`);
      try {
        const resp = await fetch(`https://api.supabase.com/v1/branches/${runtime.supabaseBranchId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${rtenv.supabase.accessToken}` },
        });
        if (resp.ok) {
          log.push("Supabase branch deleted.");
        } else {
          const body = await resp.text();
          log.push(`Supabase delete failed (${resp.status}): ${body}`);
        }
      } catch (err) {
        log.push(`Supabase delete error: ${err}`);
      }
    }
    log.push("Remote runtime stopped.");
  }

  runtime.status = "STOPPED";
  runtime.servicesEnabled = false;
  runtime.servicePortMap = undefined;
  store.saveRuntime(project.path, branch, type, runtime);

  // Also clear servicesEnabled on the agent so auto-start doesn't re-trigger
  if (type === "LOCAL") {
    const agents = store.listAgents(project.path);
    const agent = agents.find((a) => a.branch === branch);
    if (agent) {
      agent.servicesEnabled = false;
      store.saveAgent(project.path, agent.issueId, agent);
    }
  }

  return log;
}

export async function cleanupRuntime(projectName: string, branch: string, type: store.RuntimeType): Promise<void> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const runtime = store.getRuntime(project.path, branch, type);
  if (!runtime) return;

  // Stop first
  if (["RUNNING", "STARTING", "DEPLOYING"].includes(runtime.status)) {
    await stopRuntime(projectName, branch, type);
  }

  // For LOCAL: no container to remove (it belongs to the agent), no separate runtimeDir
  // Just clean up the runtime record

  // Delete Supabase branch for REMOTE
  if (type === "REMOTE" && runtime.supabaseBranchId) {
    const rtenv = resolveRtenvConfig(project.path);
    if (rtenv.supabase?.accessToken) {
      try {
        await fetch(`https://api.supabase.com/v1/branches/${runtime.supabaseBranchId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${rtenv.supabase.accessToken}` },
        });
      } catch {
        // best effort
      }
    }
  }

  store.deleteRuntime(project.path, branch, type);
}

export async function extendTTL(projectName: string, branch: string, hours = 24): Promise<void> {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const runtime = store.getRuntime(project.path, branch, "REMOTE");
  if (!runtime) throw new Error(`Runtime not found: REMOTE/${branch}`);

  const base = runtime.expiresAt && new Date(runtime.expiresAt) > new Date() ? new Date(runtime.expiresAt) : new Date();
  runtime.expiresAt = new Date(base.getTime() + hours * 60 * 60 * 1000).toISOString();
  store.saveRuntime(project.path, branch, "REMOTE", runtime);
}

export async function getRuntimeLogs(
  projectName: string,
  branch: string,
  type: store.RuntimeType,
  tail: number = 100
): Promise<string> {
  const project = store.getProjectByName(projectName);
  if (!project) return "";

  const runtime = store.getRuntime(project.path, branch, type);
  if (!runtime) return "";

  // REMOTE — return operation log
  if (type === "REMOTE") {
    const opLog = runtime.operationLog || [];
    if (opLog.length === 0) return "No operations logged yet...";
    return opLog
      .map((e) => {
        const time = new Date(e.ts).toLocaleTimeString();
        const icon = e.ok ? "\u2713" : "\u2717";
        return `[${time}] ${icon} ${e.msg}`;
      })
      .join("\n");
  }

  // LOCAL host mode — read from store log file
  if (runtime.mode === "host") {
    const safe = safeBranchName(branch);
    return store.readLog(project.path, `runtime-${safe}`, tail);
  }

  // LOCAL container mode — Docker container logs (same container as agent)
  if (!runtime.containerName) return "";
  return getContainerLogs(runtime.containerName, tail);
}

export async function getRuntimeInfo(projectName: string, branch: string, type: store.RuntimeType) {
  const project = store.getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const runtime = store.getRuntime(project.path, branch, type);
  if (!runtime) throw new Error(`Runtime not found: ${type}/${branch}`);

  let containerStatus = null;
  if (runtime.containerName) {
    containerStatus = await getContainerStatus(runtime.containerName);
  }

  return { runtime, containerStatus };
}

export async function listForProject(projectName: string): Promise<store.RuntimeData[]> {
  const project = store.getProjectByName(projectName);
  if (!project) return [];
  const runtimes = store.listRuntimes(project.path);

  // Batch: get running containers once
  const runningContainers = await cmd.getRunningContainers({ source: "runtime" });

  // Reconcile RUNNING LOCAL runtimes in parallel
  await Promise.all(runtimes.map(async (rt) => {
    if (rt.type !== "LOCAL" || rt.status !== "RUNNING") return;

    // Host mode: check if tracked child processes are still alive
    if (rt.mode === "host") {
      const hk = hostKey(project.path, rt.branch);
      const children = hostProcesses.get(hk);
      const alive = children && children.some(c => c.exitCode === null);
      if (!alive) {
        rt.status = "STOPPED";
        rt.updatedAt = new Date().toISOString();
        store.saveRuntime(project.path, rt.branch, rt.type, rt);
      }
      return;
    }

    // Container mode
    if (!rt.containerName) return;
    let processAlive = false;
    if (runningContainers.has(rt.containerName)) {
      const r = await cmd.dockerExec(rt.containerName, 'pgrep -f "node|npm" 2>/dev/null', { source: "runtime" });
      processAlive = r.ok && r.stdout !== "";
    }

    if (!processAlive) {
      rt.status = "STOPPED";
      rt.updatedAt = new Date().toISOString();
      store.saveRuntime(project.path, rt.branch, rt.type, rt);
    }
  }));

  return runtimes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// getRemoteUrl removed — using simpleGit inline where needed

function readEnvFile(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function detectDevScript(projectDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    const scripts = pkg.scripts || {};
    for (const name of ["dev", "dev:watch", "start:dev", "serve", "start"]) {
      if (scripts[name]) return `npm run ${name}`;
    }
  } catch {
    // no package.json
  }
  return "npm run dev";
}
