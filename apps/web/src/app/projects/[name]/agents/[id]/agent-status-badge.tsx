"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

interface UiStatus {
  status: "starting" | "running" | "awaiting" | "closing" | "closed";
  reason?: "completed" | "error" | "conflict";
}

const uiStatusColors: Record<string, string> = {
  starting: "bg-yellow-500 text-white border-0",
  running: "bg-green-500 text-white border-0",
  awaiting: "bg-orange-500 text-white border-0",
  closing: "bg-blue-500 text-white border-0",
  closed: "bg-gray-500 text-white border-0",
};

function uiStatusLabel(ui: UiStatus): string {
  if (ui.status === "awaiting") {
    if (ui.reason === "conflict") return "Conflict";
    if (ui.reason === "error") return "Error";
    return "Awaiting decision";
  }
  if (ui.status === "starting") return "Starting";
  if (ui.status === "running") return "Running";
  if (ui.status === "closing") return "Closing...";
  return "Closed";
}

interface AgentStatusBadgeProps {
  agentId: string;
  projectName: string;
  initialUiStatus: UiStatus;
}

export function AgentStatusBadge({ agentId, projectName, initialUiStatus }: AgentStatusBadgeProps) {
  const [ui, setUi] = useState<UiStatus>(initialUiStatus);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`/api/projects/${projectName}/agents/${agentId}/messages`);
        const data = await resp.json();
        if (data.uiStatus) setUi(data.uiStatus);
      } catch {
        // ignore
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [agentId, projectName]);

  return (
    <Badge className={uiStatusColors[ui.status] || ""}>
      {uiStatusLabel(ui)}
    </Badge>
  );
}
