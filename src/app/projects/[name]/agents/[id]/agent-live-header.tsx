"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { StateCard, NextSteps, type AgentStateData } from "./agent-state-panel";

interface UiStatus {
  status: "starting" | "running" | "awaiting" | "closing" | "closed";
  reason?: "completed" | "error" | "conflict";
}

interface CurrentOp {
  name: string;
  startedAt: string;
  progress?: string;
}

interface AgentLiveHeaderProps {
  issueId: string;
  projectName: string;
  initialState: AgentStateData;
  initialUiStatus: UiStatus;
  initialCurrentOp: CurrentOp | null;
  title: string;
  description?: string;
  createdBy?: string;
  branch: string;
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

export function AgentLiveHeader({
  issueId,
  projectName,
  initialState,
  initialUiStatus,
  initialCurrentOp,
  title,
  description,
  createdBy,
  branch,
}: AgentLiveHeaderProps) {
  const [state, setState] = useState<AgentStateData>(initialState);
  const [uiStatus, setUiStatus] = useState<UiStatus>(initialUiStatus);
  const [currentOp, setCurrentOp] = useState<CurrentOp | null>(initialCurrentOp);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    async function poll() {
      try {
        const resp = await fetch(`/api/agents/${issueId}/state`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.state) setState(data.state);
        if (data.uiStatus) setUiStatus(data.uiStatus);
        setCurrentOp(data.currentOperation ?? null);
      } catch {
        // ignore
      }
    }

    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [issueId]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const resp = await fetch(`/api/projects/${projectName}/agents/${issueId}/reconcile`, { method: "POST" });
      if (!resp.ok) throw new Error("Reconcile failed");
      const data = await resp.json();
      if (data.changes?.length > 0) {
        toast.success(`Refreshed: ${data.changes.join(", ")}`);
      } else {
        toast.info("No changes");
      }
      // Re-poll state
      const stateResp = await fetch(`/api/agents/${issueId}/state`);
      if (stateResp.ok) {
        const stateData = await stateResp.json();
        if (stateData.state) setState(stateData.state);
        if (stateData.uiStatus) setUiStatus(stateData.uiStatus);
        setCurrentOp(stateData.currentOperation ?? null);
      }
    } catch {
      toast.error("Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <div className="flex items-start gap-6">
        <Card className="shrink-0 py-2 px-3">
          <CardContent className="p-0">
            <StateCard state={state} currentOp={currentOp} issueId={issueId} projectName={projectName} />
          </CardContent>
        </Card>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{issueId}</h1>
            <Badge className={uiStatusColors[uiStatus.status] || ""}>
              {uiStatusLabel(uiStatus)}
            </Badge>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              title="Refresh agent state"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
          <p className="text-muted-foreground mt-1">{title}</p>
          {description && (
            <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl line-clamp-2">{description}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            Branch: {branch}
            {createdBy && <span className="ml-3">Author: {createdBy}</span>}
          </p>
        </div>
      </div>

      {/* Next steps */}
      <div className="mt-2 pt-2 border-t border-border space-y-2">
        <NextSteps
          state={state}
          currentOp={currentOp}
          issueId={issueId}
          projectName={projectName}
        />
      </div>
    </>
  );
}
