"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

/** Strip ANSI escape sequences (colors, cursor, etc.) from terminal output. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, "");
}

interface AgentLogsProps {
  agentId: string;
}

interface LogFile {
  name: string;
  updatedAt: string;
}

export function AgentLogs({ agentId }: AgentLogsProps) {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const checkNearBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Fetch file list
  useEffect(() => {
    let interval: NodeJS.Timeout;

    async function fetchFiles() {
      try {
        const resp = await fetch(`/api/agents/${agentId}/logs`);
        const data = await resp.json();
        const newFiles: LogFile[] = data.files || [];
        setFiles(newFiles);
        // Auto-select first file if nothing selected
        setSelected(prev => {
          if (prev && newFiles.some(f => f.name === prev)) return prev;
          return newFiles[0]?.name || null;
        });
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }

    fetchFiles();
    interval = setInterval(fetchFiles, 10000); // refresh file list every 10s
    return () => clearInterval(interval);
  }, [agentId]);

  // Fetch selected file content
  useEffect(() => {
    if (!selected) {
      setLogs("");
      return;
    }

    let interval: NodeJS.Timeout;

    async function fetchContent() {
      try {
        const resp = await fetch(`/api/agents/${agentId}/logs?file=${selected}&tail=200`);
        const data = await resp.json();
        setLogs(data.logs || "No output yet");
      } catch {
        setLogs("Error fetching logs");
      }
    }

    fetchContent();
    interval = setInterval(fetchContent, 3000);
    return () => clearInterval(interval);
  }, [agentId, selected]);

  // Auto-scroll
  useEffect(() => {
    if (isNearBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs]);

  if (loading) {
    return <div className="text-muted-foreground text-sm">Loading logs...</div>;
  }

  if (files.length === 0) {
    return <div className="text-muted-foreground text-sm">No logs available</div>;
  }

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      {/* File selector */}
      <div className="flex gap-1 flex-wrap shrink-0">
        {files.map(f => (
          <button
            key={f.name}
            onClick={() => setSelected(f.name)}
            className={cn(
              "px-2 py-0.5 rounded text-xs font-mono transition-colors",
              selected === f.name
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            {f.name}
          </button>
        ))}
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={checkNearBottom}
        className="bg-black rounded-lg p-4 font-mono text-xs text-green-400 overflow-auto flex-1 min-h-0 whitespace-pre-wrap"
      >
        {stripAnsi(logs)}
      </div>
    </div>
  );
}
