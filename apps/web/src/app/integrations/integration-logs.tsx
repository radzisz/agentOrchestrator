"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface LogEntry {
  ts: string;
  message: string;
}

export function IntegrationLogs({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    try {
      const resp = await fetch(`/api/integrations/logs?name=${name}`);
      if (resp.ok) {
        setLogs(await resp.json());
      }
    } catch {
      // ignore
    }
  }, [name]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchLogs().finally(() => setLoading(false));
    const id = setInterval(fetchLogs, 5000);
    return () => clearInterval(id);
  }, [open, fetchLogs]);

  return (
    <div className="border-t border-border pt-3">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs px-2 -ml-2"
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide Logs" : "Show Logs"}
        {!open && logs.length > 0 && (
          <span className="ml-1 text-muted-foreground">({logs.length})</span>
        )}
      </Button>

      {open && (
        <div className="mt-2 bg-black rounded border border-border max-h-72 overflow-auto">
          {loading && logs.length === 0 ? (
            <p className="text-xs text-muted-foreground p-3">Loading...</p>
          ) : logs.length === 0 ? (
            <p className="text-xs text-muted-foreground p-3">No logs yet</p>
          ) : (
            <div className="p-2 space-y-0">
              {logs.map((entry, i) => (
                <div key={i} className="flex gap-2 text-[11px] font-mono leading-5 hover:bg-white/5">
                  <span className="text-muted-foreground shrink-0">
                    {formatTime(entry.ts)}
                  </span>
                  <span className="text-green-400 whitespace-pre-wrap break-all">
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
