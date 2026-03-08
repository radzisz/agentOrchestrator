// ---------------------------------------------------------------------------
// Typed Event Bus — singleton for agent lifecycle events
// ---------------------------------------------------------------------------

import { EventEmitter } from "events";
import type { EventMap } from "@orchestrator/contracts";

// Extend EventMap with internal events not in contracts
export interface CoreEventMap extends EventMap {
  "agent:wake": { agentId: string; issueId: string; message: string };
  "agent:stopped": { agentId: string; issueId: string };
  "agent:exited": { agentId: string; issueId: string };
  "agent:cleanup": { agentId: string; issueId: string };
  "incoming:message": { issueId: string; source: string; message: string; userId?: string };
}

export class TypedEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof CoreEventMap>(
    event: K,
    listener: (data: CoreEventMap[K]) => void,
  ): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof CoreEventMap>(
    event: K,
    listener: (data: CoreEventMap[K]) => void,
  ): void {
    this.emitter.off(event, listener);
  }

  emit<K extends keyof CoreEventMap>(event: K, data: CoreEventMap[K]): void {
    this.emitter.emit(event, data);
  }

  once<K extends keyof CoreEventMap>(
    event: K,
    listener: (data: CoreEventMap[K]) => void,
  ): void {
    this.emitter.once(event, listener);
  }
}

const globalForEventBus = globalThis as unknown as {
  eventBus: TypedEventBus | undefined;
};

export const eventBus =
  globalForEventBus.eventBus ?? new TypedEventBus();

globalForEventBus.eventBus = eventBus;
