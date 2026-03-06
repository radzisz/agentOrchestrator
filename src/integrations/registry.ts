import { readdirSync, existsSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import { eventBus } from "@/lib/event-bus";
import type { Integration, IntegrationContext } from "./types";

// Re-export for types.ts
export type TypedEventBus = typeof eventBus;

const integrations = new Map<string, { integration: Integration; ctx: IntegrationContext }>();

// ---------------------------------------------------------------------------
// In-memory log ring buffer (last N entries per integration)
// ---------------------------------------------------------------------------

const MAX_LOG_ENTRIES = 200;

interface LogEntry {
  ts: string;
  message: string;
}

const globalForLogs = globalThis as unknown as {
  __integrationLogs: Map<string, LogEntry[]> | undefined;
};
const logBuffers = globalForLogs.__integrationLogs ?? new Map<string, LogEntry[]>();
globalForLogs.__integrationLogs = logBuffers;

export function appendLog(integrationName: string, message: string): void {
  let buf = logBuffers.get(integrationName);
  if (!buf) {
    buf = [];
    logBuffers.set(integrationName, buf);
  }
  buf.push({ ts: new Date().toISOString(), message });
  if (buf.length > MAX_LOG_ENTRIES) {
    buf.splice(0, buf.length - MAX_LOG_ENTRIES);
  }
  console.log(`[integration:${integrationName}] ${message}`);
}

export function getLogs(integrationName: string): LogEntry[] {
  return logBuffers.get(integrationName) ?? [];
}

export function getAllLogs(): Record<string, LogEntry[]> {
  const result: Record<string, LogEntry[]> = {};
  for (const [name, buf] of logBuffers) {
    result[name] = buf;
  }
  return result;
}

// ---------------------------------------------------------------------------

function createContext(integrationName: string): IntegrationContext {
  return {
    eventBus: eventBus as any,
    async getConfig(key: string, _projectId?: string) {
      return store.getIntegrationConfigValue(integrationName, key);
    },
    async setConfig(key: string, value: string, _projectId?: string) {
      store.setIntegrationConfigValue(integrationName, key, value);
    },
    log(message: string) {
      appendLog(integrationName, message);
    },
  };
}

export async function registerIntegration(integ: Integration, builtIn: boolean = false): Promise<void> {
  // Ensure integration exists in config.json
  const appConfig = store.getConfig();
  if (!appConfig.integrations[integ.name]) {
    appConfig.integrations[integ.name] = { enabled: true };
    store.saveConfig(appConfig);
  }

  const ctx = createContext(integ.name);
  integrations.set(integ.name, { integration: integ, ctx });

  if (integ.onRegister) {
    await integ.onRegister(ctx);
  }

  // Wire up event listeners with error handling
  function wrapHandler<T>(handler: (data: T) => Promise<void>) {
    return (data: T) => {
      const integConfig = store.getIntegrationConfig(integ.name);
      if (!integConfig.enabled) return;
      try {
        handler(data).catch((err) => {
          appendLog(integ.name, `Event handler error: ${String(err)}`);
          console.error(`[integration:${integ.name}] handler error:`, err);
        });
      } catch (err) {
        appendLog(integ.name, `Event handler error: ${String(err)}`);
        console.error(`[integration:${integ.name}] handler error:`, err);
      }
    };
  }

  if (integ.onAgentSpawned) {
    eventBus.on("agent:spawned", wrapHandler(integ.onAgentSpawned.bind(integ)));
  }
  if (integ.onAgentCommit) {
    eventBus.on("agent:commit", wrapHandler(integ.onAgentCommit.bind(integ)));
  }
  if (integ.onAgentCompleted) {
    eventBus.on("agent:completed", wrapHandler(integ.onAgentCompleted.bind(integ)));
  }
  if (integ.onAgentPreview) {
    eventBus.on("agent:preview", wrapHandler(integ.onAgentPreview.bind(integ)));
  }
  if (integ.onAgentMerged) {
    eventBus.on("agent:merged", wrapHandler(integ.onAgentMerged.bind(integ)));
  }
  if (integ.onAgentError) {
    eventBus.on("agent:error", wrapHandler(integ.onAgentError.bind(integ)));
  }
  if (integ.onIncomingMessage) {
    eventBus.on("incoming:message", wrapHandler(integ.onIncomingMessage.bind(integ)));
  }

  console.log(`[registry] Registered integration: ${integ.displayName}`);
}

export async function loadBuiltInIntegrations(): Promise<void> {
  const { telegramIntegration } = await import("./telegram");
  await registerIntegration(telegramIntegration, true);

  const { linearIntegration } = await import("./linear");
  await registerIntegration(linearIntegration, true);

  const { sentryIntegration } = await import("./sentry");
  await registerIntegration(sentryIntegration, true);

  const { localDriveIntegration } = await import("./local-drive");
  await registerIntegration(localDriveIntegration, true);

  const { githubIntegration } = await import("./github");
  await registerIntegration(githubIntegration, true);
}

// Indirection to prevent Turbopack/webpack from statically analyzing the require
declare const __non_webpack_require__: typeof require | undefined;
const dynamicRequire = typeof __non_webpack_require__ !== "undefined"
  ? __non_webpack_require__
  : eval("require");

export async function loadUserIntegrations(): Promise<void> {
  const intDir = join(process.cwd(), "integrations");
  if (!existsSync(intDir)) return;

  const files = readdirSync(intDir).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js")
  );

  for (const file of files) {
    try {
      const mod = dynamicRequire(join(intDir, file));
      const integ: Integration = mod.default || mod.integration;
      if (integ?.name) {
        await registerIntegration(integ, false);
      }
    } catch (error) {
      console.error(`[registry] Failed to load integration ${file}:`, error);
    }
  }
}

export function getIntegration(name: string) {
  return integrations.get(name);
}

export function getAllIntegrations() {
  return Array.from(integrations.values());
}
