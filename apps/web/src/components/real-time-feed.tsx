"use client";

import { useEffect, useRef, useState } from "react";

interface FeedEvent {
  id: number;
  type: string;
  data: any;
  timestamp: string;
}

export function RealTimeFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const lastIdRef = useRef(0);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const resp = await fetch(`/api/feed?after=${lastIdRef.current}`);
        if (!resp.ok || !active) return;
        const data: FeedEvent[] = await resp.json();
        if (data.length > 0) {
          // data comes newest-first; the highest id is data[0]
          lastIdRef.current = data[0].id;
          setEvents((prev) => [...data, ...prev].slice(0, 50));
        }
      } catch {
        // silent
      }
    }

    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
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
      <div className="space-y-1 max-h-[400px] overflow-auto">
        {events.length === 0 && (
          <p className="text-sm text-muted-foreground">No events yet...</p>
        )}
        {events.map((event) => (
          <div
            key={event.id}
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
