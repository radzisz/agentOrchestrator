// Re-export event bus from @orchestrator/core
// The web app uses the singleton from the core package.
export { TypedEventBus, eventBus } from "@orchestrator/core";
export type { CoreEventMap as EventMap } from "@orchestrator/core";

// Re-export event types from contracts for backward compatibility
export type {
  AgentSpawnedEvent,
  AgentCommitEvent,
  AgentCompletedEvent,
  AgentPreviewEvent,
  AgentMergedEvent,
  AgentErrorEvent,
  IncomingMessageEvent,
} from "@orchestrator/contracts";
