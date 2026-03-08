// ---------------------------------------------------------------------------
// AI Provider contract — abstract base class for AI agent backends
// ---------------------------------------------------------------------------

import type { ProviderTypeSchema } from "./config-schema";

export interface AIProviderDriver {
  processPattern: string;
  outputLogPath: string;
  buildLaunchCommand(prompt: string): string;
  buildEnvVars(projectConfig: Record<string, string>, instanceConfig?: Record<string, string>): string[];
  filterOutput(raw: string): string;
}

export abstract class BaseAIProvider {
  abstract readonly name: string;
  abstract readonly schema: ProviderTypeSchema;
  abstract createDriver(config: Record<string, string>): AIProviderDriver;
}
