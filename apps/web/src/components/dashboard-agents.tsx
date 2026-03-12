"use client";

import { useState } from "react";
import { AgentCard } from "@/components/agent-card";
import { Badge } from "@/components/ui/badge";
import { stripImages } from "@/lib/markdown-images";

type ViewMode = "grid" | "list";

interface UiStatus {
  status: "starting" | "running" | "awaiting" | "closing" | "closed";
  reason?: "completed" | "error" | "conflict";
}

const uiStatusColors: Record<string, string> = {
  starting: "bg-yellow-500",
  running: "bg-green-500",
  awaiting: "bg-orange-500",
  closing: "bg-blue-500",
  closed: "bg-gray-500",
};

function uiStatusLabel(ui: UiStatus): string {
  if (ui.status === "awaiting") {
    if (ui.reason === "conflict") return "Conflict";
    if (ui.reason === "error") return "Error";
    return "Awaiting";
  }
  if (ui.status === "starting") return "Starting";
  if (ui.status === "running") return "Running";
  if (ui.status === "closing") return "Closing";
  return "Closed";
}

interface AgentItem {
  issueId: string;
  title: string;
  status: string;
  uiStatus?: UiStatus;
  containerName?: string | null;
  branch?: string | null;
  projectName?: string;
  portSlot?: number;
  updatedAt: string | Date;
}

function usePersistedView(key: string, fallback: ViewMode): [ViewMode, (v: ViewMode) => void] {
  const [view, setViewState] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return fallback;
    return (localStorage.getItem(key) as ViewMode) || fallback;
  });
  const setView = (v: ViewMode) => {
    setViewState(v);
    localStorage.setItem(key, v);
  };
  return [view, setView];
}

export function DashboardAgents({ agents }: { agents: AgentItem[] }) {
  const [view, setView] = usePersistedView("dashboard-view-mode", "grid");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-orange-500">Requires Attention ({agents.length})</h2>
        <div className="flex border rounded-md overflow-hidden">
          <button
            onClick={() => setView("grid")}
            className={`px-2 py-1 text-xs ${
              view === "grid"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
            title="Tiles"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="1" y="1" width="6" height="6" rx="1" />
              <rect x="9" y="1" width="6" height="6" rx="1" />
              <rect x="1" y="9" width="6" height="6" rx="1" />
              <rect x="9" y="9" width="6" height="6" rx="1" />
            </svg>
          </button>
          <button
            onClick={() => setView("list")}
            className={`px-2 py-1 text-xs ${
              view === "list"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
            title="List"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="1" y1="3" x2="15" y2="3" />
              <line x1="1" y1="8" x2="15" y2="8" />
              <line x1="1" y1="13" x2="15" y2="13" />
            </svg>
          </button>
        </div>
      </div>

      {agents.length === 0 ? (
        <p className="text-muted-foreground text-sm">All clear</p>
      ) : view === "grid" ? (
        <div className="grid grid-cols-3 gap-4">
          {agents.map((agent) => (
            <AgentCard key={`${agent.projectName}/${agent.issueId}`} agent={agent} />
          ))}
        </div>
      ) : (
        <div className="border rounded-md divide-y">
          {agents.map((agent) => {
            const ui = agent.uiStatus || { status: "closed" as const };
            return (
              <a
                key={`${agent.projectName}/${agent.issueId}`}
                href={`/agents/${agent.issueId}`}
                className="flex items-center gap-4 px-4 py-2.5 hover:bg-muted/50 transition-colors"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${uiStatusColors[ui.status] || "bg-gray-500"}`} />
                <span className="font-medium text-sm w-28 shrink-0">{agent.issueId}</span>
                <span className="text-sm text-muted-foreground truncate flex-1">{stripImages(agent.title)}</span>
                {agent.projectName && (
                  <span className="text-xs text-muted-foreground shrink-0">{agent.projectName}</span>
                )}
                <Badge
                  className={`${uiStatusColors[ui.status] || "bg-gray-500"} text-white border-0 text-[10px] shrink-0`}
                >
                  {uiStatusLabel(ui)}
                </Badge>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
