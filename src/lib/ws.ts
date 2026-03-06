import { WebSocketServer, WebSocket } from "ws";
import { eventBus, type EventMap } from "./event-bus";

let wss: WebSocketServer | null = null;

export function initWebSocket(server: { on: Function }): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: any, socket: any, head: any) => {
    if (request.url === "/ws") {
      wss!.handleUpgrade(request, socket, head, (ws) => {
        wss!.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Bridge event bus to WebSocket clients
  const events: (keyof EventMap)[] = [
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

  for (const eventName of events) {
    eventBus.on(eventName, (data) => {
      broadcast({ type: eventName, data, timestamp: new Date().toISOString() });
    });
  }

  return wss;
}

export function broadcast(message: unknown): void {
  if (!wss) return;
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
