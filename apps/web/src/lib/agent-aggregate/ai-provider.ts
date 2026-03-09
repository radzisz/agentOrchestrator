// ---------------------------------------------------------------------------
// AI Provider abstraction — supports Claude Code CLI and Aider backends
// ---------------------------------------------------------------------------

import type { AgentData, AIProviderInstance } from "@/lib/store";
import { getAIProviderInstance, getDefaultAIProviderInstance } from "@/lib/store";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AIProviderType = "claude-code" | "aider" | "gemini";
export type AiderBackend = "anthropic" | "openai" | "ollama";

export interface AIProviderConfig {
  provider: AIProviderType;
  model?: string;              // "sonnet", "opus", "gpt-4o", "llama3"
  aiderBackend?: AiderBackend; // only relevant when provider === "aider"
}

export interface AIProviderDriver {
  /** grep pattern for `ps aux` to detect the running process */
  processPattern: string;
  /** path to tee'd output log inside the container */
  outputLogPath: string;
  /** Build the shell command to launch the agent process */
  buildLaunchCommand(prompt: string): string;
  /** Build env vars for the container exec / create */
  buildEnvVars(projectConfig: Record<string, string>, instanceConfig?: Record<string, string>): string[];
  /** Filter raw output (strip noise) */
  filterOutput(raw: string): string;
}

export const DEFAULT_PROVIDER: AIProviderConfig = {
  provider: "claude-code",
  model: "sonnet",
};

// ---------------------------------------------------------------------------
// Instance → Config conversion
// ---------------------------------------------------------------------------

export function instanceToConfig(instance: AIProviderInstance): AIProviderConfig {
  return {
    provider: instance.type as AIProviderType,
    model: instance.config.model || undefined,
    aiderBackend: (instance.config.aiderBackend as AiderBackend) || undefined,
  };
}

// ---------------------------------------------------------------------------
// Resolution: agent instanceId → project instanceId → default instance → hardcoded
// ---------------------------------------------------------------------------

export function resolveProviderConfig(
  agent: Pick<AgentData, "aiProviderInstanceId">,
  projectConfig: Record<string, string>,
): AIProviderConfig {
  // 1. Agent-level instance
  if (agent.aiProviderInstanceId) {
    const inst = getAIProviderInstance(agent.aiProviderInstanceId);
    if (inst) return instanceToConfig(inst);
  }

  // 2. Project-level instance
  const projectInstanceId = projectConfig.AI_PROVIDER_INSTANCE_ID;
  if (projectInstanceId) {
    const inst = getAIProviderInstance(projectInstanceId);
    if (inst) return instanceToConfig(inst);
  }

  // 3. System default instance
  const defaultInst = getDefaultAIProviderInstance();
  if (defaultInst) return instanceToConfig(defaultInst);

  // 4. Hardcoded fallback
  return DEFAULT_PROVIDER;
}

/** Resolve the full AIProviderInstance (or undefined) for env-var injection */
export function resolveProviderInstance(
  agent: Pick<AgentData, "aiProviderInstanceId">,
  projectConfig: Record<string, string>,
): AIProviderInstance | undefined {
  if (agent.aiProviderInstanceId) {
    const inst = getAIProviderInstance(agent.aiProviderInstanceId);
    if (inst) return inst;
  }
  const projectInstanceId = projectConfig.AI_PROVIDER_INSTANCE_ID;
  if (projectInstanceId) {
    const inst = getAIProviderInstance(projectInstanceId);
    if (inst) return inst;
  }
  return getDefaultAIProviderInstance();
}

// ---------------------------------------------------------------------------
// Claude Code driver
// ---------------------------------------------------------------------------

function filterClaudeOutput(raw: string): string {
  if (!raw) return "";
  const lines = raw.split("\n").filter((line) => {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/.test(line)) return false;
    if (line.includes("[entrypoint]")) return false;
    if (line.includes("[runtime]")) return false;
    if (line.includes("node --trace-warnings")) return false;
    if (line.includes("Unable to open browser automatically")) return false;
    if (line.includes("Starting framework dev server")) return false;
    if (line.includes("Local dev server ready")) return false;
    if (line.includes("Waiting for framework dev server")) return false;
    if (/^[\s│┌┐└┘─╭╮╰╯┤├]+$/.test(line)) return false;
    return true;
  });
  return lines.join("\n").trim();
}

function createClaudeCodeDriver(model: string): AIProviderDriver {
  return {
    processPattern: "claude.*--dangerously-skip-permissions",
    outputLogPath: "/tmp/claude-output.log",

    buildLaunchCommand(prompt: string): string {
      const escaped = prompt.replace(/'/g, "'\\''");
      return `gosu agent claude -p --dangerously-skip-permissions --model ${model} '${escaped}' 2>&1 | tee /tmp/claude-output.log`;
    },

    buildEnvVars(): string[] {
      return [
        `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
      ];
    },

    filterOutput: filterClaudeOutput,
  };
}

// ---------------------------------------------------------------------------
// Aider driver
// ---------------------------------------------------------------------------

function filterAiderOutput(raw: string): string {
  if (!raw) return "";
  const lines = raw.split("\n").filter((line) => {
    // Strip aider version banner
    if (/^Aider v\d/.test(line)) return false;
    // Strip repo map info
    if (line.startsWith("Repo-map:")) return false;
    if (line.startsWith("Use /help")) return false;
    if (line.startsWith("Model:")) return false;
    if (line.startsWith("Git repo:")) return false;
    if (line.startsWith("Weak model:")) return false;
    // Strip empty box-drawing lines (same as Claude)
    if (/^[\s│┌┐└┘─╭╮╰╯┤├]+$/.test(line)) return false;
    return true;
  });
  return lines.join("\n").trim();
}

function resolveAiderModelFlag(backend: AiderBackend, model?: string): string {
  switch (backend) {
    case "anthropic": {
      const m = model || "claude-sonnet-4-20250514";
      // If user gave a bare name like "sonnet" or "opus", expand it
      const shortMap: Record<string, string> = {
        sonnet: "claude-sonnet-4-20250514",
        opus: "claude-opus-4-20250514",
        haiku: "claude-haiku-4-5-20251001",
      };
      const resolved = shortMap[m] || m;
      return `--model anthropic/${resolved}`;
    }
    case "openai": {
      const m = model || "gpt-4o";
      return `--model openai/${m}`;
    }
    case "ollama": {
      const m = model || "llama3";
      return `--model ollama/${m}`;
    }
    default:
      return `--model anthropic/claude-sonnet-4-20250514`;
  }
}

function createAiderDriver(backend: AiderBackend, model?: string): AIProviderDriver {
  const modelFlag = resolveAiderModelFlag(backend, model);

  return {
    processPattern: "aider.*--yes-always",
    outputLogPath: "/tmp/aider-output.log",

    buildLaunchCommand(prompt: string): string {
      const escaped = prompt.replace(/'/g, "'\\''");
      return `gosu agent aider ${modelFlag} --yes-always --no-pretty --no-auto-commits --message '${escaped}' 2>&1 | tee /tmp/aider-output.log`;
    },

    buildEnvVars(_projectConfig: Record<string, string>, instanceConfig?: Record<string, string>): string[] {
      const vars: string[] = [];
      switch (backend) {
        case "anthropic":
          vars.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`);
          break;
        case "openai":
          vars.push(`OPENAI_API_KEY=${instanceConfig?.OPENAI_API_KEY || process.env.OPENAI_API_KEY || ""}`);
          break;
        case "ollama":
          vars.push("OLLAMA_API_BASE=http://host.docker.internal:11434");
          break;
      }
      return vars;
    },

    filterOutput: filterAiderOutput,
  };
}

// ---------------------------------------------------------------------------
// Gemini driver
// ---------------------------------------------------------------------------

function filterGeminiOutput(raw: string): string {
  if (!raw) return "";
  const lines = raw.split("\n").filter((line) => {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/.test(line)) return false;
    if (line.includes("[entrypoint]")) return false;
    if (line.includes("[runtime]")) return false;
    if (/^[\s│┌┐└┘─╭╮╰╯┤├]+$/.test(line)) return false;
    return true;
  });
  return lines.join("\n").trim();
}

function createGeminiDriver(model: string): AIProviderDriver {
  return {
    processPattern: "gemini.*-p",
    outputLogPath: "/tmp/gemini-output.log",

    buildLaunchCommand(prompt: string): string {
      const escaped = prompt.replace(/'/g, "'\\''");
      return `gosu agent gemini -p --yes --model ${model} '${escaped}' 2>&1 | tee /tmp/gemini-output.log`;
    },

    buildEnvVars(_projectConfig: Record<string, string>, instanceConfig?: Record<string, string>): string[] {
      return [
        `GEMINI_API_KEY=${instanceConfig?.apiKey || process.env.GEMINI_API_KEY || ""}`,
      ];
    },

    filterOutput: filterGeminiOutput,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getProviderDriver(config: AIProviderConfig): AIProviderDriver {
  if (config.provider === "aider") {
    return createAiderDriver(config.aiderBackend || "anthropic", config.model);
  }
  if (config.provider === "gemini") {
    return createGeminiDriver(config.model || "gemini-2.5-pro");
  }
  return createClaudeCodeDriver(config.model || "sonnet");
}
