import { EventEmitter } from "events";

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
  source: string; // "telegram", "linear"
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
  "agent:wake": { agentId: string; issueId: string; message: string };
  "agent:stopped": { agentId: string; issueId: string };
  "agent:exited": { agentId: string; issueId: string };
  "agent:cleanup": { agentId: string; issueId: string };
  "incoming:message": IncomingMessageEvent;
}

class TypedEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof EventMap>(
    event: K,
    listener: (data: EventMap[K]) => void
  ): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof EventMap>(
    event: K,
    listener: (data: EventMap[K]) => void
  ): void {
    this.emitter.off(event, listener);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.emitter.emit(event, data);
  }

  once<K extends keyof EventMap>(
    event: K,
    listener: (data: EventMap[K]) => void
  ): void {
    this.emitter.once(event, listener);
  }
}

const globalForEventBus = globalThis as unknown as {
  eventBus: TypedEventBus | undefined;
};

export const eventBus =
  globalForEventBus.eventBus ?? new TypedEventBus();

// Always persist on globalThis — Next.js may create multiple module instances
globalForEventBus.eventBus = eventBus;
