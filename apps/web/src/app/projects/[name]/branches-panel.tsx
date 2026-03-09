"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface RuntimeInfo {
  id: string;
  type: "LOCAL" | "REMOTE";
  status: "STARTING" | "DEPLOYING" | "RUNNING" | "STOPPED" | "FAILED";
  branch: string;
  containerName: string | null;
  previewUrl: string | null;
  supabaseUrl: string | null;
  expiresAt: string | null;
  error: string | null;
  netlifyDeployIds: Array<{ siteName: string; deployId: string }> | null;
  servicePortMap: Array<{ name: string; hostPort: number }> | null;
  portSlot: {
    id: string;
    slot: number;
  } | null;
}

interface RemoteStatusData {
  supabase: { status: string; error?: string } | null;
  deploys: Array<{ siteName: string; state: string; url?: string; error?: string }>;
  allReady: boolean;
  anyFailed: boolean;
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

interface BranchInfo {
  name: string;
  issueId: string | null;
  commit: { sha: string; message: string; author: string; date: string };
  aheadBy: number;
  behindBy: number;
  agentId: string | null;
  agentStatus: string | null;
  agentUiStatus: { status: string; reason?: string } | null;
  previewUrls: Array<{ name: string; url: string }>;
  supabaseConfigured: boolean;
  netlifyConfigured: boolean;
  localRuntime: RuntimeInfo | null;
  remoteRuntime: RuntimeInfo | null;
  runtimeConfig: RuntimeConfigData | null;
  runtimeModes: { local: boolean; remote: boolean };
  pullRequest: {
    number: number;
    title: string;
    state: string;
    url: string;
  } | null;
}

const uiStatusColors: Record<string, string> = {
  starting: "bg-yellow-500",
  running: "bg-green-500",
  awaiting: "bg-orange-500",
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

function portFromSlot(slot: number): number {
  const nn = slot.toString().padStart(2, "0");
  return parseInt(`4${nn}22`);
}

function Spinner() {
  return (
    <svg className="animate-spin -ml-0.5 mr-1.5 h-3 w-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function TTLCountdown({ expiresAt, onExtend, extending }: {
  expiresAt: string;
  onExtend: () => void;
  extending: boolean;
}) {
  const [remaining, setRemaining] = useState("");
  const [color, setColor] = useState("text-green-400");

  useEffect(() => {
    function update() {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining("expired");
        setColor("text-red-500");
        return;
      }
      const hours = Math.floor(diff / 3_600_000);
      const mins = Math.floor((diff % 3_600_000) / 60_000);
      setRemaining(hours > 0 ? `${hours}h ${mins}m` : `${mins}m`);
      setColor(hours >= 6 ? "text-green-400" : hours >= 1 ? "text-yellow-400" : "text-red-400");
    }
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return (
    <div className="flex items-center gap-1">
      <span className={`text-xs font-mono ${color}`}>{remaining}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-[10px]"
        onClick={onExtend}
        disabled={extending}
      >
        {extending ? "..." : "+24h"}
      </Button>
    </div>
  );
}

const UI_STATUS_FILTERS = ["starting", "running", "awaiting", "closed"] as const;
const DEFAULT_HIDDEN = new Set(["closed"]);

export function BranchesPanel({ projectName, runtimeType }: { projectName: string; runtimeType?: "LOCAL" | "REMOTE" }) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState<string | null>(null);
  const [logsContent, setLogsContent] = useState<string>("");
  const [search, setSearch] = useState("");
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set(DEFAULT_HIDDEN));

  useEffect(() => {
    loadBranches();
  }, [projectName]);

  async function loadBranches() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/projects/${projectName}/branches`);
      if (!resp.ok) {
        const data = await resp.json();
        setError(data.error || "Failed to load branches");
        return;
      }
      setBranches(await resp.json());
    } catch (err) {
      setError("Failed to load branches");
    } finally {
      setLoading(false);
    }
  }

  async function refreshRuntimes() {
    try {
      const resp = await fetch(`/api/projects/${projectName}/runtimes`);
      if (!resp.ok) return;
      const runtimes: RuntimeInfo[] = await resp.json();
      const byBranch = new Map<string, { local: RuntimeInfo | null; remote: RuntimeInfo | null }>();
      for (const rt of runtimes) {
        const entry = byBranch.get(rt.branch) || { local: null, remote: null };
        if (rt.type === "LOCAL") entry.local = rt;
        else entry.remote = rt;
        byBranch.set(rt.branch, entry);
      }
      setBranches(prev => prev.map(b => {
        const updated = byBranch.get(b.name);
        if (!updated) return { ...b, localRuntime: null, remoteRuntime: null };
        return { ...b, localRuntime: updated.local, remoteRuntime: updated.remote };
      }));
    } catch {
      // silent
    }
  }

  async function startRuntime(branch: string, type: "LOCAL" | "REMOTE") {
    const key = `${type}:${branch}`;
    setBusy(key);
    try {
      const resp = await fetch(`/api/projects/${projectName}/runtimes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch, type }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        console.error("[runtime] error:", data.error);
      }
      await refreshRuntimes();
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
        const lines = (data.log as string[] || []).join("\n");
        setLogsContent("Stopping runtime...\n" + lines + "\nDone.");
      } else {
        setLogsContent("Stopping runtime...\nError: " + (data.error || "Failed"));
      }
      await refreshRuntimes();
    } catch {
      setLogsContent("Stopping runtime...\nFailed to stop runtime.");
    } finally {
      setBusy(null);
    }
  }

  const fetchLogs = useCallback(async (runtimeId: string) => {
    try {
      const resp = await fetch(
        `/api/projects/${projectName}/runtimes/${runtimeId}/logs?tail=150`
      );
      const data = await resp.json();
      setLogsContent(data.logs || "No logs yet...");
    } catch {
      setLogsContent("Failed to load logs");
    }
  }, [projectName]);

  function viewLogs(runtimeId: string) {
    if (logsOpen === runtimeId) {
      setLogsOpen(null);
      return;
    }
    setLogsOpen(runtimeId);
    setLogsContent("Loading...");
    fetchLogs(runtimeId);
  }

  // Auto-refresh logs every 5s when panel is open
  useEffect(() => {
    if (!logsOpen) return;
    const interval = setInterval(() => fetchLogs(logsOpen), 5000);
    return () => clearInterval(interval);
  }, [logsOpen, fetchLogs]);

  async function extendRuntime(runtimeId: string, branch: string) {
    setBusy(`extend:${branch}`);
    try {
      await fetch(`/api/projects/${projectName}/runtimes/${runtimeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 24 }),
      });
    } catch {
      console.error("[runtime] extend TTL failed");
    } finally {
      setBusy(null);
    }
  }

  async function createPR(branch: BranchInfo) {
    setBusy(`pr:${branch.name}`);
    try {
      const title = branch.issueId
        ? `${branch.issueId}: ${branch.commit.message}`
        : branch.commit.message;

      const resp = await fetch(`/api/projects/${projectName}/branches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-pr",
          branch: branch.name,
          title,
          draft: true,
        }),
      });
      const result = await resp.json();
      if (result.url) {
        window.open(result.url, "_blank");
      } else {
        console.error("[pr] create failed:", JSON.stringify(result));
      }
    } catch {
      console.error("[pr] create failed");
    } finally {
      setBusy(null);
    }
  }

  function toggleStatus(s: string) {
    setHiddenStatuses(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  // Collect UI statuses present in data for chips
  const presentStatuses = new Set(branches.map(b => b.agentUiStatus?.status).filter(Boolean) as string[]);
  const statusChips = UI_STATUS_FILTERS.filter(s => presentStatuses.has(s));

  // Apply filters
  const searchLower = search.toLowerCase();
  const filtered = branches.filter(b => {
    // Status filter — branches with no agent always pass
    if (b.agentUiStatus && hiddenStatuses.has(b.agentUiStatus.status)) return false;
    // Text search
    if (searchLower) {
      const haystack = `${b.name} ${b.issueId || ""} ${b.commit.message}`.toLowerCase();
      if (!haystack.includes(searchLower)) return false;
    }
    return true;
  });

  const header = (
    <div className="space-y-2 mb-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Branches</h2>
        <Button variant="ghost" size="sm" onClick={loadBranches} disabled={loading}>
          {loading ? "Loading..." : "Reload"}
        </Button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          placeholder="Search branches..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 px-2 text-sm rounded border border-border bg-background w-48 focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {statusChips.map(s => {
          const active = !hiddenStatuses.has(s);
          return (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={`h-6 px-2 text-[11px] rounded-full border transition-colors ${
                active
                  ? "bg-accent text-accent-foreground border-border"
                  : "bg-transparent text-muted-foreground border-transparent line-through opacity-50"
              }`}
            >
              {uiStatusLabel({ status: s })}
            </button>
          );
        })}
        {filtered.length !== branches.length && (
          <span className="text-xs text-muted-foreground">
            {filtered.length}/{branches.length}
          </span>
        )}
      </div>
    </div>
  );

  if (loading && branches.length === 0) {
    return (
      <div>
        {header}
        <p className="text-sm text-muted-foreground">Loading remote branches...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {header}
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <div>
        {header}
        <p className="text-sm text-muted-foreground">No open branches</p>
      </div>
    );
  }

  return (
    <div>
      {header}

      <div className="border rounded-lg divide-y divide-border">
        {filtered.map((branch) => (
          <div key={branch.name}>
            <div className="p-3 flex items-center gap-4">
              {/* Branch info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-medium">
                    {branch.issueId || branch.name}
                  </span>

                  {branch.agentUiStatus && (
                    <Badge
                      className={`${uiStatusColors[branch.agentUiStatus.status] || "bg-gray-500"} text-white border-0 text-[10px] px-1.5`}
                    >
                      {uiStatusLabel(branch.agentUiStatus)}
                    </Badge>
                  )}

                  {branch.pullRequest && (
                    <a
                      href={branch.pullRequest.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Badge variant="outline" className="text-[10px] px-1.5 cursor-pointer hover:bg-accent">
                        PR #{branch.pullRequest.number}
                      </Badge>
                    </a>
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

                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {branch.commit.message}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {branch.commit.author} · {branch.commit.date ? timeSince(branch.commit.date) : "—"} · {branch.commit.sha.substring(0, 7)}
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-col gap-1 shrink-0 items-end">
                {/* Row: PR + Agent buttons */}
                <div className="flex items-center gap-1.5">
                  {!branch.pullRequest && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => createPR(branch)}
                      disabled={busy === `pr:${branch.name}`}
                    >
                      {busy === `pr:${branch.name}` ? "..." : "PR"}
                    </Button>
                  )}

                  {branch.agentId && (
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`/agents/${branch.agentId}`}>Agent</a>
                    </Button>
                  )}
                </div>

                {/* LOCAL runtime row */}
                {(!runtimeType || runtimeType === "LOCAL") && branch.runtimeModes.local && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground w-10">Local</span>
                    <RuntimeControls
                      runtime={branch.localRuntime}
                      type="LOCAL"
                      label="Local"
                      branch={branch.name}
                      busy={busy}
                      onStart={() => startRuntime(branch.name, "LOCAL")}
                      onStop={(id) => stopRuntime(id, branch.name)}
                      onExtend={(id) => extendRuntime(id, branch.name)}
                      onLogs={(id) => viewLogs(id)}
                      logsOpen={logsOpen}
                      projectName={projectName}
                      onRefresh={refreshRuntimes}
                      runtimeConfig={branch.runtimeConfig}
                    />
                  </div>
                )}

                {/* REMOTE runtime row */}
                {(!runtimeType || runtimeType === "REMOTE") && branch.runtimeModes.remote && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground w-10">Remote</span>
                    <RuntimeControls
                      runtime={branch.remoteRuntime}
                      type="REMOTE"
                      label="Start"
                      branch={branch.name}
                      busy={busy}
                      onStart={() => startRuntime(branch.name, "REMOTE")}
                      onStop={(id) => stopRuntime(id, branch.name)}
                      onExtend={(id) => extendRuntime(id, branch.name)}
                      onLogs={(id) => viewLogs(id)}
                      logsOpen={logsOpen}
                      projectName={projectName}
                      onRefresh={refreshRuntimes}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Logs panel */}
            {logsOpen &&
              (branch.localRuntime?.id === logsOpen ||
                branch.remoteRuntime?.id === logsOpen) && (
                <div className="px-3 pb-3">
                  <pre className="bg-black text-green-400 text-xs p-3 rounded max-h-60 overflow-auto font-mono whitespace-pre-wrap">
                    {logsContent}
                  </pre>
                </div>
              )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RuntimeControls — sub-component for LOCAL / REMOTE per branch
// ---------------------------------------------------------------------------

function RuntimeControls({
  runtime,
  type,
  label,
  branch,
  busy,
  onStart,
  onStop,
  onExtend,
  onLogs,
  logsOpen,
  projectName,
  onRefresh,
  runtimeConfig,
}: {
  runtime: RuntimeInfo | null;
  type: "LOCAL" | "REMOTE";
  label: string;
  branch: string;
  busy: string | null;
  onStart: () => void;
  onStop: (id: string) => void;
  onExtend: (id: string) => void;
  onLogs: (id: string) => void;
  logsOpen: string | null;
  projectName: string;
  onRefresh: () => void;
  runtimeConfig?: RuntimeConfigData | null;
}) {
  const startKey = `${type}:${branch}`;
  const stopKey = `stop:${branch}`;
  const isStarting = busy === startKey;
  const isStopping = busy === stopKey;

  // No runtime — show start button
  if (!runtime || runtime.status === "STOPPED") {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={onStart}
        disabled={isStarting}
      >
        {isStarting && <Spinner />}
        {label}
      </Button>
    );
  }

  // STARTING — spinner
  if (runtime.status === "STARTING") {
    return (
      <Badge className="bg-yellow-500 text-white border-0 text-[10px] px-1.5 animate-pulse">
        Starting...
      </Badge>
    );
  }

  // DEPLOYING — show progress with polling
  if (runtime.status === "DEPLOYING") {
    return (
      <DeployProgress
        runtime={runtime}
        projectName={projectName}
        branch={branch}
        busy={busy}
        onStop={onStop}
        onLogs={onLogs}
        logsOpen={logsOpen}
        onReady={onRefresh}
      />
    );
  }

  // FAILED — error + retry
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
          Retry
        </Button>
      </div>
    );
  }

  // RUNNING — read service → host port mapping from DB (saved at container start)
  const serviceLinks: Array<{ name: string; hostPort: number }> = [];

  if (type === "LOCAL" && runtime.servicePortMap && runtime.servicePortMap.length > 0) {
    for (const entry of runtime.servicePortMap) {
      serviceLinks.push({ name: entry.name, hostPort: entry.hostPort });
    }
  }

  return (
    <div className="flex items-center gap-1">
      {serviceLinks.map((link) => (
        <ServiceLink key={link.name} name={link.name} port={link.hostPort} runtimeId={runtime.id} />
      ))}

      {type === "REMOTE" && runtime.previewUrl && runtime.previewUrl.split(" , ").map((url, i) => (
        <RemoteServiceLink key={url.trim()} url={url.trim()} label={extractSiteName(url.trim())} />
      ))}

      {type === "REMOTE" && runtime.supabaseUrl && (
        <Badge variant="outline" className="text-[10px] px-1.5">
          DB
        </Badge>
      )}

      {type === "REMOTE" && runtime.expiresAt && (
        <TTLCountdown
          expiresAt={runtime.expiresAt}
          onExtend={() => onExtend(runtime.id)}
          extending={busy === `extend:${branch}`}
        />
      )}

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onLogs(runtime.id)}
        className={logsOpen === runtime.id ? "bg-accent" : ""}
      >
        Logs
      </Button>

      <StopButton
        type={type}
        isStopping={isStopping}
        onStop={() => onStop(runtime.id)}
      />
    </div>
  );
}

function StopButton({ type, isStopping, onStop, small }: {
  type: "LOCAL" | "REMOTE";
  isStopping: boolean;
  onStop: () => void;
  small?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  function handleClick() {
    if (type === "REMOTE" && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onStop();
  }

  const cls = small ? "h-6 px-1.5 text-[10px]" : "";

  if (confirming) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className={cls}
        onClick={handleClick}
        disabled={isStopping}
      >
        DB will be deleted — confirm?
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className={cls}
      onClick={handleClick}
      disabled={isStopping}
    >
      {isStopping && <Spinner />}
      Stop
    </Button>
  );
}

// ---------------------------------------------------------------------------
// ServiceLink — polls port health and shows loader until service is up
// ---------------------------------------------------------------------------

function ServiceLink({ name, port, runtimeId }: { name: string; port: number; runtimeId: string }) {
  const [status, setStatus] = useState<"loading" | "up" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (status === "up") return;
    let cancelled = false;

    async function check() {
      try {
        const resp = await fetch(
          `/api/health?port=${port}&runtimeId=${runtimeId}&service=${name}`
        );
        const data = await resp.json();
        if (cancelled) return;
        if (data.error) {
          setStatus("error");
          setErrorMsg(data.error);
        } else if (data.up) {
          setStatus("up");
          setErrorMsg(null);
        }
      } catch {
        // ignore
      }
    }

    check();
    const interval = setInterval(check, 4000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [port, runtimeId, name, status]);

  if (status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-600 text-white text-xs font-mono cursor-help"
        title={errorMsg || "Service failed"}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-300" />
        {name}
      </span>
    );
  }

  if (status === "loading") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-yellow-600 text-white text-xs font-mono cursor-default">
        <Spinner />
        {name}
      </span>
    );
  }

  return (
    <a
      href={`http://localhost:${port}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-mono transition-colors"
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse" />
      {name}
    </a>
  );
}

// ---------------------------------------------------------------------------
// RemoteServiceLink — polls external URL health, mirrors ServiceLink UX
// ---------------------------------------------------------------------------

function RemoteServiceLink({ url, label }: { url: string; label: string }) {
  const [status, setStatus] = useState<"loading" | "up" | "down">("loading");

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const resp = await fetch(`/api/health?url=${encodeURIComponent(url)}`);
        const data = await resp.json();
        if (cancelled) return;
        setStatus(data.up ? "up" : "down");
      } catch {
        if (!cancelled) setStatus("down");
      }
    }

    check();
    const interval = setInterval(check, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [url]);

  if (status === "loading") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-yellow-600 text-white text-xs font-mono cursor-default">
        <Spinner />
        {label}
      </span>
    );
  }

  if (status === "down") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-mono transition-colors"
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-300" />
        {label}
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-mono transition-colors"
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse" />
      {label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// DeployProgress — shown during DEPLOYING state, polls for status
// ---------------------------------------------------------------------------

function DeployProgress({
  runtime,
  projectName,
  branch,
  busy,
  onStop,
  onLogs,
  logsOpen,
  onReady,
}: {
  runtime: RuntimeInfo;
  projectName: string;
  branch: string;
  busy: string | null;
  onStop: (id: string) => void;
  onLogs: (id: string) => void;
  logsOpen: string | null;
  onReady: () => void;
}) {
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusData | null>(null);
  const isStopping = busy === `stop:${branch}`;

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const resp = await fetch(`/api/projects/${projectName}/runtimes/${runtime.id}`);
        const data = await resp.json();
        if (cancelled) return;

        if (data.remoteStatus) {
          setRemoteStatus(data.remoteStatus);
        }

        // If status transitioned away from DEPLOYING, refresh parent
        if (data.runtime?.status && data.runtime.status !== "DEPLOYING") {
          onReady();
        }
      } catch {
        // ignore
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [projectName, runtime.id, onReady]);

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <Badge className="bg-yellow-500 text-white border-0 text-[10px] px-1.5 animate-pulse">
        Deploying...
      </Badge>

      {remoteStatus?.supabase && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-muted">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
            remoteStatus.supabase.status === "active" ? "bg-green-500" :
            remoteStatus.supabase.status === "failed" ? "bg-red-500" : "bg-yellow-500 animate-pulse"
          }`} />
          DB: {remoteStatus.supabase.status}
        </span>
      )}

      {remoteStatus?.deploys.map((d) => {
        const label = `${d.siteName.split("--").pop()?.replace(".netlify.app", "") || d.siteName}: ${d.state}`;
        const dot = (
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
            d.state === "ready" ? "bg-green-500" :
            d.state === "error" ? "bg-red-500" : "bg-yellow-500 animate-pulse"
          }`} />
        );
        return d.url ? (
          <a
            key={d.siteName}
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-muted hover:bg-accent transition-colors"
            title={d.error || d.url}
          >
            {dot}
            {label}
          </a>
        ) : (
          <span
            key={d.siteName}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-muted"
            title={d.error || ""}
          >
            {dot}
            {label}
          </span>
        );
      })}

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onLogs(runtime.id)}
        className={`h-6 px-1.5 text-[10px] ${logsOpen === runtime.id ? "bg-accent" : ""}`}
      >
        Logs
      </Button>

      <StopButton
        type="REMOTE"
        isStopping={isStopping}
        onStop={() => onStop(runtime.id)}
        small
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSiteName(url: string): string {
  try {
    const hostname = new URL(url).hostname; // e.g. "branch--site-name.netlify.app"
    const parts = hostname.split("--");
    if (parts.length >= 2) {
      return parts.slice(1).join("--").replace(".netlify.app", "");
    }
    return hostname.replace(".netlify.app", "");
  } catch {
    return url;
  }
}
