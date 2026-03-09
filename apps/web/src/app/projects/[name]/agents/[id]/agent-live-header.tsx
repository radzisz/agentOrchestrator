"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { StateCard, NextSteps } from "./agent-state-panel";
import { useAgentState } from "./agent-state-context";

interface AgentLiveHeaderProps {
  issueId: string;
  projectName: string;
  title: string;
  description?: string;
  createdBy?: string;
  issueCreatedAt?: string;
  branch: string;
  gitMode: "branch" | "worktree" | null;
}

/** Strip markdown image syntax from text */
function stripImages(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]+\)/g, "").trim();
}

const uiStatusColors: Record<string, string> = {
  starting: "bg-yellow-500 text-white border-0",
  running: "bg-green-500 text-white border-0",
  awaiting: "bg-orange-500 text-white border-0",
  closing: "bg-blue-500 text-white border-0",
  closed: "bg-gray-500 text-white border-0",
};

function uiStatusLabel(ui: { status: string; reason?: string }): string {
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
  title,
  description,
  createdBy,
  issueCreatedAt,
  branch,
  gitMode,
}: AgentLiveHeaderProps) {
  const { state, uiStatus, currentOp, refreshNow } = useAgentState();
  const [refreshing, setRefreshing] = useState(false);

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
      refreshNow();
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
          <p className="text-muted-foreground mt-1 break-words">{stripImages(title)}</p>
          {description && stripImages(description) && (
            <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl line-clamp-2 break-words">{stripImages(description)}</p>
          )}
          {(createdBy || issueCreatedAt) && (
            <p className="text-xs text-muted-foreground mt-1">
              {createdBy && <span>Reporter: {createdBy}</span>}
              {issueCreatedAt && (
                <span className={createdBy ? "ml-3" : ""}>
                  {new Date(issueCreatedAt).toLocaleString("pl-PL", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-0.5">
            Branch: {branch}
            {gitMode && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-muted text-[10px] font-medium uppercase">
                {gitMode === "worktree" ? "worktree" : "clone"}
              </span>
            )}
          </p>
        </div>
      </div>
    </>
  );
}

/** Standalone next-steps bar — rendered outside the header so it's always visible */
export function AgentNextSteps({ issueId, projectName }: { issueId: string; projectName: string }) {
  const { state, currentOp } = useAgentState();
  return (
    <NextSteps
      state={state}
      currentOp={currentOp}
      issueId={issueId}
      projectName={projectName}
    />
  );
}
