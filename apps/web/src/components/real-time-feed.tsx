"use client";

import { useEffect, useState } from "react";

interface FeedEvent {
  type: string;
  data: any;
  timestamp: string;
}

export function RealTimeFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      // Reconnect after 3s
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setEvents((prev) => [data, ...prev].slice(0, 50));
      } catch {}
    };

    return () => ws.close();
  }, []);

  const eventIcon: Record<string, string> = {
    "agent:spawned": "🚀",
    "agent:commit": "📝",
    "agent:completed": "✅",
    "agent:preview": "👁",
    "agent:merged": "🔀",
    "agent:error": "❌",
    "agent:wake": "🔔",
    "agent:stopped": "⏹",
    "agent:cleanup": "🧹",
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
        />
        <span className="text-muted-foreground">
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      <div className="space-y-1 max-h-[400px] overflow-auto">
        {events.length === 0 && (
          <p className="text-sm text-muted-foreground">No events yet...</p>
        )}
        {events.map((event, i) => (
          <div
            key={i}
            className="text-sm p-2 rounded bg-muted/50 flex items-start gap-2"
          >
            <span>{eventIcon[event.type] || "📌"}</span>
            <div className="flex-1 min-w-0">
              <span className="font-medium">
                {event.type.replace("agent:", "")}
              </span>
              {event.data?.issueId && (
                <span className="text-muted-foreground ml-1">
                  {event.data.issueId}
                </span>
              )}
              {event.data?.message && (
                <p className="text-xs text-muted-foreground truncate">
                  {event.data.message}
                </p>
              )}
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {new Date(event.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
