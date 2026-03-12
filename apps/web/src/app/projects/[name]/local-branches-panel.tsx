"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GitBranch, Bot, GitFork, Info, Loader2, Container, Search, RefreshCw, ArrowUpDown } from "lucide-react";
import { ServiceLink } from "@/components/service-link";

// ---------------------------------------------------------------------------
// Types (matching API response + BranchesPanel runtime shape)
// ---------------------------------------------------------------------------

interface RuntimeInfo {
  id: string;
  type: "LOCAL" | "REMOTE";
  status: "STARTING" | "DEPLOYING" | "RUNNING" | "STOPPED" | "FAILED";
  branch: string;
  servicesEnabled: boolean;
  containerName: string | null;
  previewUrl: string | null;
  supabaseUrl: string | null;
  expiresAt: string | null;
  error: string | null;
  netlifyDeployIds: Array<{ siteName: string; deployId: string }> | null;
  servicePortMap: Array<{ name: string; hostPort: number }> | null;
  portSlot: { id: string; slot: number } | null;
}

interface ServiceConfig {
  name: string;
  cmd: string;
  port: number;
}

interface RuntimeConfigData {
  image?: string;
  installCmd?: string;
  services: ServiceConfig[];
}

interface LocalBranchInfo {
  name: string;
  issueId: string | null;
  commit: { sha: string; message: string; author: string; date: string };
  aheadBy: number;
  behindBy: number;
  agentId: string | null;
  agentStatus: string | null;
  agentUiStatus: { status: string; reason?: string } | null;
  agentTitle: string | null;
  agentCreatedBy: string | null;
  agentCreatedAt: string | null;
  agentUpdatedAt: string | null;
  containerRunning: boolean;
  localRuntime: RuntimeInfo | null;
  runtimeConfig: RuntimeConfigData | null;
  runtimeModes: { local: boolean; remote: boolean };
}

interface RemoteBranchInfo {
  name: string;
  commit: { sha: string; message: string; author: string; date: string };
  aheadBy: number;
  behindBy: number;
}

const uiStatusColors: Record<string, string> = {
  starting: "bg-yellow-500",
  running: "bg-green-500",
  awaiting: "bg-orange-500",
  closing: "bg-blue-500",
  closed: "bg-gray-500",
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

function timeSince(dateStr: string) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Spinner() {
  return (
    <svg className="animate-spin -ml-0.5 mr-1.5 h-3 w-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LocalBranchesPanel({
  projectName,
  linearConfigured,
  linearTeamKey,
  linearLabel,
  githubConfigured,
  onRefreshRef,
}: {
  projectName: string;
  linearConfigured?: boolean;
  linearTeamKey?: string | null;
  linearLabel?: string;
  githubConfigured?: boolean;
  onRefreshRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const [branches, setBranches] = useState<LocalBranchInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState<string | null>(null);
  const [logsContent, setLogsContent] = useState("");
  const [search, setSearch] = useState("");
  const [hideMerged, setHideMerged] = useState(true);
  const [sortBy, setSortBy] = useState<"code" | "created" | "updated">("updated");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [reconciling, setReconciling] = useState<string | null>(null);

  // Dialogs
  const [showCheckout, setShowCheckout] = useState(false);

  // Fast poll for 30s after mount (catches freshly dispatched agents)
  const [recentMount, setRecentMount] = useState(true);

  useEffect(() => {
    setRecentMount(true);
    loadBranches().then(() => refreshRuntimes());
    const timer = setTimeout(() => setRecentMount(false), 30_000);
    return () => clearTimeout(timer);
  }, [projectName]);

  useEffect(() => {
    if (onRefreshRef) onRefreshRef.current = () => loadBranches();
    return () => { if (onRefreshRef) onRefreshRef.current = null; };
  });

  // Auto-refresh when any agent is in a transient state (starting, running, closing)
  const hasTransient = branches.some((b) => {
    const s = b.agentUiStatus?.status;
    return s === "starting" || s === "running" || s === "closing";
  });
  useEffect(() => {
    // Fast poll (5s) when agents are in transient states or just mounted, slow poll (30s) otherwise
    const interval = setInterval(() => loadBranches().then(() => refreshRuntimes()), (hasTransient || recentMount) ? 5000 : 30000);
    return () => clearInterval(interval);
  }, [hasTransient, recentMount, projectName]);

  async function loadBranches() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/projects/${projectName}/local-branches`);
      if (!resp.ok) {
        const data = await resp.json();
        setError(data.error || "Failed to load branches");
        return;
      }
      setBranches(await resp.json());
    } catch {
      setError("Failed to load local branches");
    } finally {
      setLoading(false);
    }
  }

  async function refreshRuntimes() {
    try {
      const resp = await fetch(`/api/projects/${projectName}/runtimes`);
      if (!resp.ok) return;
      const runtimes: RuntimeInfo[] = await resp.json();
      const localByBranch = new Map<string, RuntimeInfo>();
      for (const rt of runtimes) {
        if (rt.type === "LOCAL") localByBranch.set(rt.branch, rt);
      }
      setBranches((prev) =>
        prev.map((b) => {
          // Match by agent branch (agent/{issueId}), not by git current branch name
          const agentBranch = `agent/${b.issueId}`;
          return {
            ...b,
            localRuntime: localByBranch.get(agentBranch) || localByBranch.get(b.name) || b.localRuntime,
          };
        })
      );
    } catch {
      // silent
    }
  }

  async function reconcileAgent(issueId: string) {
    setReconciling(issueId);
    try {
      const resp = await fetch(`/api/projects/${projectName}/agents/${issueId}/reconcile`, {
        method: "POST",
      });
      if (resp.ok) {
        await loadBranches();
      }
    } catch {}
    setReconciling(null);
  }

  async function startRuntime(branch: string) {
    if (busy) return; // prevent double-click
    setBusy(`start:${branch}`);
    try {
      const resp = await fetch(`/api/projects/${projectName}/runtimes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch, type: "LOCAL" }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        console.error("[runtime] start failed:", data.error);
      }
      await loadBranches();
    } catch {
      console.error("[runtime] start failed");
    } finally {
      setBusy(null);
    }
  }

  async function stopRuntime(runtimeId: string, branch: string) {
    setBusy(`stop:${branch}`);
    setLogsOpen(runtimeId);
    setLogsContent("Stopping runtime...\n");
    try {
      const resp = await fetch(`/api/projects/${projectName}/runtimes/${runtimeId}`, {
        method: "DELETE",
      });
      const data = await resp.json();
      if (resp.ok) {
        const lines = ((data.log as string[]) || []).join("\n");
        setLogsContent("Stopping runtime...\n" + lines + "\nDone.");
      } else {
        setLogsContent("Stopping runtime...\nError: " + (data.error || "Failed"));
      }
      await loadBranches();
    } catch {
      setLogsContent("Stopping runtime...\nFailed to stop runtime.");
    } finally {
      setBusy(null);
    }
  }

  const fetchLogs = useCallback(
    async (runtimeId: string) => {
      try {
        const resp = await fetch(
          `/api/projects/${projectName}/runtimes/${runtimeId}/logs?tail=150`
        );
        const data = await resp.json();
        setLogsContent(data.logs || "No logs yet...");
      } catch {
        setLogsContent("Failed to load logs");
      }
    },
    [projectName]
  );

  function viewLogs(runtimeId: string) {
    if (logsOpen === runtimeId) {
      setLogsOpen(null);
      return;
    }
    setLogsOpen(runtimeId);
    setLogsContent("Loading...");
    fetchLogs(runtimeId);
  }

  useEffect(() => {
    if (!logsOpen) return;
    const interval = setInterval(() => fetchLogs(logsOpen), 5000);
    return () => clearInterval(interval);
  }, [logsOpen, fetchLogs]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Auto-show closed if ALL agents are closed (otherwise you see empty list)
  const isTerminal = (s?: string) => s === "closed" || s === "closing";
  const allClosed = branches.length > 0 && branches.every((b) => isTerminal(b.agentUiStatus?.status));
  const effectiveHideMerged = hideMerged && !allClosed;

  const filteredBranches = branches
    .filter((b) => {
      if (effectiveHideMerged && b.agentUiStatus?.status === "closed") return false;
      if (search) {
        const q = search.toLowerCase();
        const haystack = [b.name, b.issueId, b.agentTitle, b.agentUiStatus?.status, b.commit.message]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortBy === "code") {
        const aCode = (a.issueId || a.name).toLowerCase();
        const bCode = (b.issueId || b.name).toLowerCase();
        return aCode.localeCompare(bCode, undefined, { numeric: true }) * dir;
      }
      if (sortBy === "created") {
        const aDate = a.agentCreatedAt || "";
        const bDate = b.agentCreatedAt || "";
        return aDate.localeCompare(bDate) * dir;
      }
      // "updated"
      const aDate = a.agentUpdatedAt || a.commit.date || "";
      const bDate = b.agentUpdatedAt || b.commit.date || "";
      return aDate.localeCompare(bDate) * dir;
    });

  const closedCount = branches.filter((b) => b.agentUiStatus?.status === "closed").length;

  const header = (
    <div className="space-y-2 mb-4">
      {githubConfigured && (
        <div className="flex items-center justify-end">
          <Button variant="ghost" size="sm" onClick={() => setShowCheckout(true)}>
            <GitFork className="h-3.5 w-3.5 mr-1.5" />
            Checkout branch
          </Button>
        </div>
      )}
      {branches.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents..."
              className="pl-8 h-8 text-sm"
            />
          </div>
          {/* Sort controls */}
          <div className="inline-flex rounded border border-border overflow-hidden h-7 text-xs">
            {(["code", "created", "updated"] as const).map((s) => (
              <button
                key={s}
                className={`px-2 flex items-center gap-1 transition-colors ${
                  sortBy === s
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => {
                  if (sortBy === s) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                  else { setSortBy(s); setSortDir(s === "code" ? "asc" : "desc"); }
                }}
              >
                {s === "code" ? "Code" : s === "created" ? "Created" : "Modified"}
                {sortBy === s && (
                  <span className="text-[10px]">{sortDir === "asc" ? "↑" : "↓"}</span>
                )}
              </button>
            ))}
          </div>

          {closedCount > 0 && (
            <button
              onClick={() => setHideMerged(!hideMerged)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                hideMerged
                  ? "bg-muted text-muted-foreground border-border"
                  : "bg-accent text-foreground border-border"
              }`}
            >
              {hideMerged ? `Show ${closedCount} closed` : "Hide closed"}
            </button>
          )}

          <Button variant="ghost" size="sm" className="ml-auto" onClick={async () => {
            await fetch(`/api/projects/${projectName}/refresh`, { method: "POST" });
            loadBranches();
          }} disabled={loading}>
            {loading
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}
    </div>
  );

  if (loading && branches.length === 0) {
    return (
      <div>
        {header}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Scanning local agent spaces...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {header}
        <p className="text-sm text-destructive">{error}</p>
        <ConfigSummary
          linearConfigured={linearConfigured}
          linearTeamKey={linearTeamKey}
          linearLabel={linearLabel}
        />
      </div>
    );
  }

  return (
    <div>
      {header}

      {branches.length === 0 ? (
        <p className="text-sm text-muted-foreground mb-4">No local agent spaces yet.</p>
      ) : filteredBranches.length === 0 ? (
        <p className="text-sm text-muted-foreground mb-4">No agents match filters.</p>
      ) : (
        <div className="border rounded-lg divide-y divide-border mb-4">
          {filteredBranches.map((branch) => (
            <div key={branch.agentId || branch.name}>
              <div className="p-3 flex items-center gap-4">
                {/* Branch info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {branch.agentId ? (
                      <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}

                    {branch.agentId ? (
                      <a
                        href={`/projects/${projectName}/agents/${branch.agentId}`}
                        className="font-mono text-sm font-medium hover:underline"
                      >
                        {branch.issueId || branch.name}
                      </a>
                    ) : (
                      <span className="font-mono text-sm font-medium">
                        {branch.issueId || branch.name}
                      </span>
                    )}

                    <ContainerControl
                      running={branch.containerRunning}
                      projectName={projectName}
                      issueId={branch.issueId || ""}
                      onChanged={loadBranches}
                    />

                    {branch.agentUiStatus && (
                      <Badge
                        className={`${uiStatusColors[branch.agentUiStatus.status] || "bg-gray-500"} text-white border-0 text-[10px] px-1.5`}
                      >
                        {uiStatusLabel(branch.agentUiStatus)}
                      </Badge>
                    )}

                    {branch.issueId && (
                      <button
                        onClick={(e) => { e.preventDefault(); reconcileAgent(branch.issueId!); }}
                        disabled={reconciling === branch.issueId}
                        className="p-0.5 rounded hover:bg-accent transition-colors"
                        title="Reconcile agent state"
                      >
                        <RefreshCw className={`h-3 w-3 text-muted-foreground ${reconciling === branch.issueId ? "animate-spin" : ""}`} />
                      </button>
                    )}

                    {branch.localRuntime && ["STARTING", "RUNNING", "FAILED"].includes(branch.localRuntime.status) && (
                      <>
                        <Badge
                          className={`${
                            branch.localRuntime.status === "RUNNING" ? "bg-green-500" :
                            branch.localRuntime.status === "STARTING" ? "bg-yellow-500" :
                            "bg-red-500"
                          } text-white border-0 text-[10px] px-1.5`}
                        >
                          Preview: {branch.localRuntime.status === "RUNNING" ? "Running" :
                            branch.localRuntime.status === "STARTING" ? "Starting" : "Failed"}
                        </Badge>
                        <button
                          onClick={() => viewLogs(branch.localRuntime!.id)}
                          className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                            logsOpen === branch.localRuntime.id
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                          title="Toggle logs"
                        >
                          Logs
                        </button>
                      </>
                    )}

                    {branch.aheadBy > 0 && (
                      <span className="text-xs text-green-400 font-mono">
                        +{branch.aheadBy}
                      </span>
                    )}
                    {branch.behindBy > 0 && (
                      <span className="text-xs text-red-400 font-mono">
                        -{branch.behindBy}
                      </span>
                    )}
                  </div>

                  {branch.agentTitle && (
                    <a
                      href={`/projects/${projectName}/agents/${branch.agentId}`}
                      className="text-xs text-muted-foreground truncate mt-0.5 block hover:underline"
                    >
                      {branch.agentTitle}
                      {branch.agentCreatedBy && (
                        <span className="text-[11px] ml-2 opacity-60">by {branch.agentCreatedBy}</span>
                      )}
                    </a>
                  )}

                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {branch.commit.message}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {branch.commit.author} · {branch.commit.date ? timeSince(branch.commit.date) : "—"} · {branch.commit.sha}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <RuntimeControls
                    runtime={branch.localRuntime}
                    branch={branch.localRuntime?.branch || `agent/${branch.issueId}`}
                    busy={busy}
                    onStart={() => startRuntime(branch.localRuntime?.branch || `agent/${branch.issueId}`)}
                    onStop={(id) => stopRuntime(id, branch.localRuntime?.branch || `agent/${branch.issueId}`)}
                    onLogs={(id) => viewLogs(id)}
                    logsOpen={logsOpen}
                    projectName={projectName}
                    onRefresh={refreshRuntimes}
                    runtimeConfig={branch.runtimeConfig}
                  />
                </div>
              </div>

              {/* Logs panel */}
              {logsOpen && branch.localRuntime?.id === logsOpen && (
                <div className="px-3 pb-3">
                  <pre className="bg-black text-green-400 text-xs p-3 rounded max-h-60 overflow-auto font-mono whitespace-pre-wrap">
                    {logsContent}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Config summary */}
      <ConfigSummary
        linearConfigured={linearConfigured}
        linearTeamKey={linearTeamKey}
        linearLabel={linearLabel}
      />

      {/* Checkout remote branch dialog */}
      {showCheckout && (
        <CheckoutBranchDialog
          projectName={projectName}
          localBranchNames={new Set(branches.flatMap((b) => [b.name, b.issueId ? `agent/${b.issueId}` : ""].filter(Boolean)))}
          onClose={() => setShowCheckout(false)}
          onCheckedOut={() => {
            setShowCheckout(false);
            loadBranches();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfigSummary — explains how agent spaces are created
// ---------------------------------------------------------------------------

function ConfigSummary({
  linearConfigured,
  linearTeamKey,
  linearLabel,
}: {
  linearConfigured?: boolean;
  linearTeamKey?: string | null;
  linearLabel?: string;
}) {
  return (
    <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <div>
        {linearConfigured ? (
          <p>
            Agent spaces are created automatically when the dispatcher picks up
            Linear issues labeled{" "}
            <span className="font-mono font-medium text-foreground">{linearLabel || "agent"}</span>
            {linearTeamKey && (
              <> in team <span className="font-mono font-medium text-foreground">{linearTeamKey}</span></>
            )}.
            Submit new tasks in the <span className="font-medium text-foreground">Tasks</span> tab.
          </p>
        ) : (
          <p>
            Agent spaces are created automatically from Linear issues.
            Configure Linear integration (API Key + Team Key) in the{" "}
            <span className="font-medium text-foreground">Integrations</span> tab to enable automatic dispatching.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CheckoutBranchDialog — lists remote branches, creates local copy
// ---------------------------------------------------------------------------

function CheckoutBranchDialog({
  projectName,
  localBranchNames,
  onClose,
  onCheckedOut,
}: {
  projectName: string;
  localBranchNames: Set<string>;
  onClose: () => void;
  onCheckedOut: () => void;
}) {
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranchInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    loadRemoteBranches();
  }, [projectName]);

  async function loadRemoteBranches() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/projects/${projectName}/branches`);
      if (!resp.ok) {
        const data = await resp.json();
        setError(data.error || "Failed to load remote branches");
        return;
      }
      setRemoteBranches(await resp.json());
    } catch {
      setError("Failed to load remote branches");
    } finally {
      setLoading(false);
    }
  }

  async function checkoutBranch(branchName: string) {
    setBusy(branchName);
    try {
      const resp = await fetch(`/api/projects/${projectName}/checkout-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: branchName }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        console.error("[runtime] checkout failed:", data.error);
      } else {
        onCheckedOut();
      }
    } catch {
      console.error("[runtime] checkout failed");
    } finally {
      setBusy(null);
    }
  }

  const filtered = remoteBranches.filter((b) =>
    b.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border rounded-xl p-6 w-full max-w-lg space-y-4 max-h-[80vh] flex flex-col">
        <h2 className="text-lg font-semibold">Checkout remote branch</h2>
        <p className="text-sm text-muted-foreground">
          Fetch a remote branch and create a local workspace for it.
        </p>

        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter branches..."
          autoFocus
        />

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading remote branches...
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}

          {!loading && !error && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {remoteBranches.length === 0 ? "No remote branches found." : "No branches match filter."}
            </p>
          )}

          {!loading && filtered.length > 0 && (
            <div className="border rounded-lg divide-y divide-border">
              {filtered.map((branch) => {
                const isLocal = localBranchNames.has(branch.name);
                return (
                  <div key={branch.name} className={`p-2.5 flex items-center gap-3 ${isLocal ? "opacity-40" : ""}`}>
                    <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-sm truncate">{branch.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {isLocal ? "Already checked out locally" : branch.commit.message}
                      </p>
                    </div>
                    {!isLocal && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => checkoutBranch(branch.name)}
                        disabled={busy === branch.name}
                      >
                        {busy === branch.name ? <Spinner /> : null}
                        Checkout
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContainerControl — clickable container icon with start/stop popup
// ---------------------------------------------------------------------------

function ContainerControl({
  running,
  projectName,
  issueId,
  onChanged,
}: {
  running: boolean;
  projectName: string;
  issueId: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleAction(action: "start" | "stop") {
    setBusy(true);
    try {
      const resp = await fetch(`/api/projects/${projectName}/agents/${issueId}/container`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        console.error("[container]", data.error);
      }
      onChanged();
    } catch (err) {
      console.error("[container]", err);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="p-0.5 rounded hover:bg-accent transition-colors"
        title={running ? "Container running" : "Container stopped"}
      >
        <Container className={`h-3.5 w-3.5 ${running ? "text-green-500" : "text-gray-400"}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-card border rounded-lg shadow-lg p-2 min-w-[160px]">
          <div className="text-[11px] text-muted-foreground mb-1.5 px-1">
            Container: {running ? "Running" : "Stopped"}
          </div>
          {running ? (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start text-xs"
              onClick={() => handleAction("stop")}
              disabled={busy}
            >
              {busy && <Spinner />}
              Stop container
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start text-xs"
              onClick={() => handleAction("start")}
              disabled={busy}
            >
              {busy && <Spinner />}
              Start container
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RuntimeControls
// ---------------------------------------------------------------------------

function RuntimeControls({
  runtime,
  branch,
  busy,
  onStart,
  onStop,
  onLogs,
  logsOpen,
  projectName,
  onRefresh,
  runtimeConfig,
}: {
  runtime: RuntimeInfo | null;
  branch: string;
  busy: string | null;
  onStart: () => void;
  onStop: (id: string) => void;
  onLogs: (id: string) => void;
  logsOpen: string | null;
  projectName: string;
  onRefresh: () => void;
  runtimeConfig?: RuntimeConfigData | null;
}) {
  const isStarting = busy === `start:${branch}`;
  const isStopping = busy === `stop:${branch}`;

  // Services not requested — show Start button
  if (!runtime || (runtime.status === "STOPPED" && !runtime.servicesEnabled)) {
    return (
      <Button variant="outline" size="sm" onClick={onStart} disabled={isStarting}>
        {isStarting && <Spinner />}
        Services: Start
      </Button>
    );
  }

  // Services requested but still booting (STARTING, or STOPPED with servicesEnabled)
  if (runtime.status === "STARTING" || (runtime.status === "STOPPED" && runtime.servicesEnabled)) {
    return (
      <div className="flex items-center gap-1">
        <Badge className="bg-yellow-500 text-white border-0 text-[10px] px-1.5 animate-pulse">
          Starting...
        </Badge>
        <Button variant="outline" size="sm" onClick={() => onStop(runtime.id)} disabled={isStopping}>
          {isStopping && <Spinner />}
          Stop
        </Button>
      </div>
    );
  }

  if (runtime.status === "FAILED") {
    return (
      <div className="flex items-center gap-1">
        <Badge className="bg-red-500 text-white border-0 text-[10px] px-1.5" title={runtime.error || ""}>
          Failed
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onLogs(runtime.id)}
          className={logsOpen === runtime.id ? "bg-accent" : ""}
        >
          Logs
        </Button>
        <Button variant="outline" size="sm" onClick={onStart} disabled={isStarting}>
          {isStarting && <Spinner />}
          Services: Retry
        </Button>
      </div>
    );
  }

  // RUNNING — build service links from portSlot + config (source of truth for names)
  const serviceLinks: Array<{ name: string; hostPort: number }> = [];
  const cfgServices = runtimeConfig?.services || [];

  if (runtime.servicePortMap && runtime.servicePortMap.length > 0) {
    for (const entry of runtime.servicePortMap) {
      serviceLinks.push({ name: entry.name, hostPort: entry.hostPort });
    }
  }

  return (
    <div className="flex items-center gap-1">
      {serviceLinks.map((link) => (
        <ServiceLink key={link.name} name={link.name} port={link.hostPort} runtimeId={runtime.id} />
      ))}

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onLogs(runtime.id)}
        className={logsOpen === runtime.id ? "bg-accent" : ""}
      >
        Logs
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={() => onStop(runtime.id)}
        disabled={isStopping}
      >
        {isStopping && <Spinner />}
        Stop
      </Button>
    </div>
  );
}
