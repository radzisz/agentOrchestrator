// ---------------------------------------------------------------------------
// Event bus types — agent lifecycle events
// ---------------------------------------------------------------------------

export interface AgentSpawnedEvent {
  agentId: string;
  issueId: string;
  projectName: string;
  containerName: string;
  branch: string;
}

export interface AgentCommitEvent {
  agentId: string;
  issueId: string;
  message: string;
  hash: string;
}

export interface AgentCompletedEvent {
  agentId: string;
  issueId: string;
}

export interface AgentPreviewEvent {
  agentId: string;
  issueId: string;
  previewUrl?: string;
  supabaseUrl?: string;
}

export interface AgentMergedEvent {
  agentId: string;
  issueId: string;
  branch: string;
}

export interface AgentErrorEvent {
  agentId: string;
  issueId: string;
  error: string;
}

export interface IncomingMessageEvent {
  issueId: string;
  source: string;
  message: string;
  userId?: string;
}

export interface EventMap {
  "agent:spawned": AgentSpawnedEvent;
  "agent:commit": AgentCommitEvent;
  "agent:completed": AgentCompletedEvent;
  "agent:preview": AgentPreviewEvent;
  "agent:merged": AgentMergedEvent;
  "agent:error": AgentErrorEvent;
  "agent:message": IncomingMessageEvent;
}
