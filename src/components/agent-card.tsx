"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
    return "Awaiting decision";
  }
  if (ui.status === "starting") return "Starting";
  if (ui.status === "running") return "Running";
  if (ui.status === "closing") return "Closing...";
  return "Closed";
}

interface AgentCardProps {
  agent: {
    issueId: string;
    title: string;
    status: string;
    uiStatus?: UiStatus;
    containerName?: string | null;
    branch?: string | null;
    projectName?: string;
    portSlot?: number;
    updatedAt: string | Date;
  };
}

export function AgentCard({ agent }: AgentCardProps) {
  const [removing, setRemoving] = useState(false);
  const portSlot = agent.portSlot != null
    ? `Slot ${agent.portSlot.toString().padStart(2, "0")}`
    : null;
  const ui = agent.uiStatus || { status: "closed" as const };
  const canRemove = ui.status === "closed" || ui.status === "awaiting";

  async function handleRemove() {
    setRemoving(true);
    await fetch(`/api/agents/${agent.issueId}`, { method: "DELETE" });
    window.location.reload();
  }

  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            <a href={`/agents/${agent.issueId}`} className="hover:underline">
              {agent.issueId}
            </a>
          </CardTitle>
          <Badge
            className={`${uiStatusColors[ui.status] || "bg-gray-500"} text-white border-0`}
          >
            {uiStatusLabel(ui)}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground truncate">{agent.title}</p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {agent.projectName && <span>Project: {agent.projectName}</span>}
          {agent.branch && <span>Branch: {agent.branch}</span>}
          {portSlot && <span>{portSlot}</span>}
        </div>
        <div className="flex gap-2 mt-3">
          <Button variant="outline" size="sm" asChild>
            <a href={`/agents/${agent.issueId}`}>Details</a>
          </Button>
          {canRemove && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleRemove}
              disabled={removing}
            >
              {removing ? "..." : "Remove"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
