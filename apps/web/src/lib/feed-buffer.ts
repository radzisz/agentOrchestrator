import { eventBus, type EventMap } from "./event-bus";

export interface FeedEvent {
  id: number;
  type: string;
  data: any;
  timestamp: string;
}

const MAX_EVENTS = 100;

const TRACKED_EVENTS: (keyof EventMap)[] = [
  "agent:spawned",
  "agent:commit",
  "agent:completed",
  "agent:preview",
  "agent:merged",
  "agent:error",
  "agent:wake",
  "agent:stopped",
  "agent:cleanup",
  "incoming:message",
];

// Use globalThis so the buffer survives module re-evaluation by Turbopack
const g = globalThis as unknown as {
  __feedBuffer?: FeedEvent[];
  __feedNextId?: number;
  __feedInit?: boolean;
};

function getBuffer(): FeedEvent[] {
  if (!g.__feedBuffer) g.__feedBuffer = [];
  return g.__feedBuffer;
}

function getNextId(): number {
  if (!g.__feedNextId) g.__feedNextId = 1;
  return g.__feedNextId;
}

function bumpId(): number {
  const id = getNextId();
  g.__feedNextId = id + 1;
  return id;
}

export function initFeedBuffer(): void {
  if (g.__feedInit) return;
  g.__feedInit = true;

  for (const eventName of TRACKED_EVENTS) {
    eventBus.on(eventName, (data) => {
      const buffer = getBuffer();
      buffer.push({
        id: bumpId(),
        type: eventName,
        data,
        timestamp: new Date().toISOString(),
      });
      if (buffer.length > MAX_EVENTS) {
        buffer.splice(0, buffer.length - MAX_EVENTS);
      }
    });
  }
}

/** Get events after a given id. Returns newest first. */
export function getEvents(afterId = 0, limit = 50): FeedEvent[] {
  const buffer = getBuffer();
  const filtered = afterId > 0
    ? buffer.filter((e) => e.id > afterId)
    : buffer;
  return filtered.slice(-limit).reverse();
}
