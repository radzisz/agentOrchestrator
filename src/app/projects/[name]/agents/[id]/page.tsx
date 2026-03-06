import * as store from "@/lib/store";
import { notFound } from "next/navigation";
import { AgentActions } from "./agent-actions";
import { AgentContent } from "./agent-content";
import { AgentLiveHeader } from "./agent-live-header";
import { ServicesBar } from "./services-bar";
import { getAggregate } from "@/lib/agent-aggregate";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ name: string; id: string }>;
}) {
  const { name: projectName, id } = await params;

  const project = store.getProjectByName(projectName);
  if (!project) notFound();

  const agent = store.getAgent(project.path, id);
  if (!agent) notFound();

  // Refresh state from actual system (Docker, git, etc.) on every page load
  try {
    const agg = getAggregate(projectName, id);
    await agg.refreshAgent();
  } catch {
    // best effort — continue with cached state
  }

  // Re-read after refresh
  const freshAgent = store.getAgent(project.path, id) || agent;

  const runtimeConfig = store.getProjectJsonField<{
    services?: Array<{ name: string; cmd: string; port: number }>;
  }>(project.path, "RUNTIME_CONFIG");
  const cfgServices = runtimeConfig?.services || [];
  const safeBranch = freshAgent.branch?.replace(/[^a-zA-Z0-9_-]/g, "-") || "";
  const runtimeId = `LOCAL/${safeBranch}`;

  const uiStatus = freshAgent.uiStatus || { status: "closed" as const };
  const agentState = freshAgent.state || null;
  const currentOp = freshAgent.currentOperation ?? null;

  return (
    <div className="flex flex-col h-full">
      {/* Header — fixed, never scrolls */}
      <div className="shrink-0 bg-background px-6 py-3 border-b border-border z-10">
        {agentState ? (
          <AgentLiveHeader
            issueId={freshAgent.issueId}
            projectName={projectName}
            initialState={agentState}
            initialUiStatus={uiStatus}
            initialCurrentOp={currentOp}
            title={freshAgent.title || ""}
            description={freshAgent.description}
            branch={freshAgent.branch || ""}
          />
        ) : (
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold">{freshAgent.issueId}</h1>
            <p className="text-muted-foreground mt-1">{freshAgent.title}</p>
          </div>
        )}

        {/* Services bar */}
        {cfgServices.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border">
            <ServicesBar
              projectName={projectName}
              issueId={freshAgent.issueId}
              runtimeId={runtimeId}
              cfgServices={cfgServices}
              initialEnabled={freshAgent.servicesEnabled ?? false}
            />
          </div>
        )}

        {/* AgentActions hosts confirmation dialogs only (no visible buttons) */}
        <AgentActions agentId={freshAgent.issueId} projectName={projectName} uiStatus={uiStatus} />
      </div>

      {/* Content — fills remaining space, tabs manage their own scroll */}
      <div className="flex-1 min-h-0">
        <AgentContent
          projectName={projectName}
          issueId={freshAgent.issueId}
          uiStatus={uiStatus}
        />
      </div>
    </div>
  );
}
