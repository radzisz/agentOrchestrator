import type { TypedEventBus } from "./registry";

export interface IntegrationConfigField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "secret" | "select";
  required?: boolean;
  description?: string;
  default?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface IntegrationContext {
  eventBus: TypedEventBus;
  getConfig(key: string, projectId?: string): Promise<string | null>;
  setConfig(key: string, value: string, projectId?: string): Promise<void>;
  log(message: string): void;
}

export interface Integration {
  name: string;
  displayName: string;
  configSchema?: IntegrationConfigField[];

  onRegister?(ctx: IntegrationContext): Promise<void>;
  onAgentSpawned?(event: { agentId: string; issueId: string; projectName: string; containerName: string; branch: string }): Promise<void>;
  onAgentCommit?(event: { agentId: string; issueId: string; message: string; hash: string }): Promise<void>;
  onAgentCompleted?(event: { agentId: string; issueId: string }): Promise<void>;
  onAgentPreview?(event: { agentId: string; issueId: string; previewUrl?: string; supabaseUrl?: string }): Promise<void>;
  onAgentMerged?(event: { agentId: string; issueId: string; branch: string }): Promise<void>;
  onAgentError?(event: { agentId: string; issueId: string; error: string }): Promise<void>;
  onIncomingMessage?(event: { issueId: string; source: string; message: string; userId?: string }): Promise<void>;
}
