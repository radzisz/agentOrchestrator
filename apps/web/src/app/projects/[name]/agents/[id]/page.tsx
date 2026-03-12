import { existsSync, lstatSync, readFileSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import { notFound } from "next/navigation";
import { AgentActions } from "./agent-actions";
import { AgentContent } from "./agent-content";
import { AgentLiveHeader } from "./agent-live-header";
import { AgentNextSteps } from "./agent-live-header";
import { AgentStateProvider } from "./agent-state-context";
import { ServicesBar } from "./services-bar";
import { RemotePreviewBar } from "./remote-preview-bar";
import { getAggregate } from "@/lib/agent-aggregate";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";

function detectGitMode(agentDir: string): "branch" | "worktree" | null {
  const dotGit = join(agentDir, ".git");
  if (!existsSync(dotGit)) return null;
  // git worktree creates a .git *file* (not directory) containing "gitdir: ..."
  const stat = lstatSync(dotGit);
  if (stat.isFile()) {
    try {
      const content = readFileSync(dotGit, "utf-8");
      if (content.trim().startsWith("gitdir:")) return "worktree";
    } catch {}
  }
  return "branch";
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ name: string; id: string }> }) {
  const { id } = await params;
  return { title: `10xDev: ${id}` };
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ name: string; id: string }>;
}) {
  const { name: projectName, id } = await params;

  const project = store.getProjectByName(projectName);
  if (!project) {
    console.error(`[agent-page] Project not found: "${projectName}"`);
    notFound();
  }

  const agent = store.getAgent(project.path, id);
  if (!agent) {
    console.error(`[agent-page] Agent not found: "${id}" in project "${projectName}" (path: ${project.path})`);
    notFound();
  }

  // Kick off a background refresh — don't block SSR.
  // The client-side AgentStateProvider polls /api/agents/:id/state every few seconds
  // and will pick up fresh data automatically.
  try {
    const agg = getAggregate(projectName, id);
    agg.refreshAgent().catch(() => {});
  } catch {
    // best effort
  }
  const freshAgent = agent;
  const gitMode = freshAgent.agentDir ? detectGitMode(freshAgent.agentDir) : null;

  const runtimeConfig = store.getProjectJsonField<{
    services?: Array<{ name: string; cmd: string; port: number }>;
  }>(project.path, "RUNTIME_CONFIG");
  const cfgServices = runtimeConfig?.services || [];
  const safeBranch = freshAgent.branch?.replace(/[^a-zA-Z0-9_-]/g, "-") || "";
  const runtimeId = `LOCAL/${safeBranch}`;

  const linearConfig = resolveTrackerConfig(project.path, "linear");
  const remoteRuntime = freshAgent.branch
    ? store.getRuntime(project.path, freshAgent.branch, "REMOTE")
    : null;
  const runtimeModes = store.getProjectJsonField<{ local: boolean; remote: boolean }>(project.path, "RUNTIME_MODES") || { local: true, remote: false };

  const uiStatus = freshAgent.uiStatus || { status: "closed" as const };
  const agentState = freshAgent.state || null;
  const currentOp = freshAgent.currentOperation ?? null;

  return (
    <AgentStateProvider
      issueId={freshAgent.issueId}
      initialState={agentState || ({} as any)}
      initialUiStatus={uiStatus}
      initialCurrentOp={currentOp}
    >
      <div className="flex flex-col h-full">
        {/* Header — fixed, never scrolls */}
        <div className="shrink-0 bg-background px-6 py-3 border-b border-border z-10 max-h-[40vh] overflow-y-auto">
          {agentState ? (
            <AgentLiveHeader
              issueId={freshAgent.issueId}
              projectName={projectName}
              title={freshAgent.title || ""}
              description={freshAgent.description}
              createdBy={freshAgent.createdBy}
              issueCreatedAt={freshAgent.issueCreatedAt}
              branch={freshAgent.branch || ""}
              gitMode={gitMode}
            />
          ) : (
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold">{freshAgent.issueId}</h1>
              <p className="text-muted-foreground mt-1 break-words">{(freshAgent.title || "").replace(/!\[[^\]]*\]\([^)]+\)/g, "").trim()}</p>
              {(freshAgent.createdBy || freshAgent.issueCreatedAt) && (
                <p className="text-xs text-muted-foreground mt-1">
                  {freshAgent.createdBy && <span>Reporter: {freshAgent.createdBy}</span>}
                  {freshAgent.issueCreatedAt && (
                    <span className={freshAgent.createdBy ? " ml-3" : ""}>
                      {new Date(freshAgent.issueCreatedAt).toLocaleString("pl-PL", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  )}
                </p>
              )}
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

          {/* Remote preview bar */}
          {runtimeModes.remote && freshAgent.branch && (
            <div className="mt-2 pt-2 border-t border-border">
              <RemotePreviewBar
                projectName={projectName}
                branch={freshAgent.branch}
                previewLabel={linearConfig?.previewLabel || undefined}
                branchOnRemote={!!(freshAgent.state?.git?.lastCommit || freshAgent.state?.git?.aheadBy)}
                initialRuntime={remoteRuntime ? {
                  id: `REMOTE/${freshAgent.branch.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
                  status: remoteRuntime.status,
                  previewUrl: remoteRuntime.previewUrl || null,
                  supabaseUrl: remoteRuntime.supabaseUrl || null,
                  expiresAt: remoteRuntime.expiresAt || null,
                  createdAt: remoteRuntime.createdAt || null,
                  error: remoteRuntime.error || null,
                } : null}
              />
            </div>
          )}

          {/* AgentActions hosts confirmation dialogs only (no visible buttons) */}
          <AgentActions agentId={freshAgent.issueId} projectName={projectName} uiStatus={uiStatus} />
        </div>

        {/* Next steps — always visible between header and content */}
        {agentState && (
          <div className="shrink-0 bg-background px-6 py-1.5 border-b border-border">
            <AgentNextSteps issueId={freshAgent.issueId} projectName={projectName} />
          </div>
        )}

        {/* Content — fills remaining space, tabs manage their own scroll */}
        <div className="flex-1 min-h-0">
          <AgentContent
            projectName={projectName}
            issueId={freshAgent.issueId}
          />
        </div>
      </div>
    </AgentStateProvider>
  );
}
