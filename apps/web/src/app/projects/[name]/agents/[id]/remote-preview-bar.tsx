"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Play, AlertTriangle, GitBranch } from "lucide-react";

interface RemoteRuntimeInfo {
  id: string;
  status: string;
  previewUrl: string | null;
  supabaseUrl: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  error: string | null;
}

export function RemotePreviewBar({
  projectName,
  branch,
  initialRuntime,
  previewLabel,
  branchOnRemote,
}: {
  projectName: string;
  branch: string;
  initialRuntime: RemoteRuntimeInfo | null;
  previewLabel?: string;
  branchOnRemote?: boolean;
}) {
  const [runtime, setRuntime] = useState<RemoteRuntimeInfo | null>(initialRuntime);
  const [busy, setBusy] = useState<string | null>(null);

  const runtimeId = `REMOTE/${branch.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const fetchStatus = useCallback(async () => {
    try {
      const resp = await fetch(`/api/projects/${projectName}/runtimes/${runtimeId}`);
      if (!resp.ok) {
        if (resp.status === 404) { setRuntime(null); return; }
        return;
      }
      const data = await resp.json();
      if (data.runtime) {
        setRuntime({
          id: runtimeId,
          status: data.runtime.status,
          previewUrl: data.runtime.previewUrl || null,
          supabaseUrl: data.runtime.supabaseUrl || null,
          expiresAt: data.runtime.expiresAt || null,
          createdAt: data.runtime.createdAt || null,
          error: data.runtime.error || null,
        });
      }
    } catch { /* silent */ }
  }, [projectName, runtimeId]);

  useEffect(() => {
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  async function handleStart() {
    setBusy("starting");
    // Set optimistic state immediately so UI shows status badge right away
    setRuntime({ id: runtimeId, status: "STARTING", previewUrl: null, supabaseUrl: null, expiresAt: null, createdAt: new Date().toISOString(), error: null });
    try {
      const resp = await fetch(`/api/projects/${projectName}/runtimes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch, type: "REMOTE" }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setRuntime({ id: runtimeId, status: "FAILED", previewUrl: null, supabaseUrl: null, expiresAt: null, createdAt: null, error: data.error || "Failed to start" });
      }
    } catch {
      // POST returned — polling will pick up actual state
    } finally {
      setBusy(null);
    }
  }

  async function handleStop() {
    setBusy("stopping");
    try {
      await fetch(`/api/projects/${projectName}/runtimes/${runtimeId}`, { method: "DELETE" });
      setRuntime(null);
    } catch { /* silent */ }
    finally { setBusy(null); }
  }

  async function handleExtend() {
    setBusy("extending");
    try {
      await fetch(`/api/projects/${projectName}/runtimes/${runtimeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 24 }),
      });
      await fetchStatus();
    } catch { /* silent */ }
    finally { setBusy(null); }
  }

  const isActive = runtime && !["STOPPED", "FAILED"].includes(runtime.status);
  const isStarting = runtime?.status === "STARTING" || runtime?.status === "DEPLOYING";

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs flex-wrap">
        <span className="text-muted-foreground">Remote Preview</span>

        {!runtime || runtime.status === "STOPPED" ? (
          branchOnRemote === false ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <GitBranch className="h-2.5 w-2.5" />
              Branch musi być na remote żeby odpalić preview
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-5 text-[10px] px-2"
              onClick={handleStart}
              disabled={busy === "starting"}
            >
              {busy === "starting" ? <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" /> : <Play className="h-2.5 w-2.5 mr-1" />}
              Start
            </Button>
          )
        ) : (
          <>
            <StatusBadge status={runtime.status} />

            {/* Preview URL links with live ping */}
            {runtime.previewUrl && runtime.previewUrl.split(" , ").map((url) => (
              <RemoteServiceLink key={url.trim()} url={url.trim()} label={extractSiteName(url.trim())} />
            ))}

            {/* Supabase indicator */}
            {runtime.supabaseUrl && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-[10px] font-mono" title={runtime.supabaseUrl}>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                DB
              </span>
            )}

            {/* TTL countdown */}
            {runtime.expiresAt && isActive && (
              <TTLCountdown
                expiresAt={runtime.expiresAt}
                onExtend={handleExtend}
                extending={busy === "extending"}
              />
            )}

            {/* Stop button */}
            {isActive && !isStarting && (
              <StopButton
                onStop={handleStop}
                isStopping={busy === "stopping"}
                supabaseUrl={runtime.supabaseUrl}
                branch={branch}
              />
            )}
          </>
        )}

        {/* Failed state */}
        {runtime?.status === "FAILED" && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-5 text-[10px] px-2"
              onClick={handleStart}
              disabled={busy === "starting"}
            >
              Retry
            </Button>
            <StopButton onStop={handleStop} isStopping={busy === "stopping"} supabaseUrl={runtime.supabaseUrl} branch={branch} />
          </>
        )}
      </div>

      {/* Info line: last restarted, expires, auto-restart note */}
      {runtime && runtime.status !== "STOPPED" && (
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground pl-0.5">
          {runtime.createdAt && (
            <span>Started: {formatDateTime(runtime.createdAt)}</span>
          )}
          {runtime.expiresAt && (
            <span>Expires: {formatDateTime(runtime.expiresAt)}</span>
          )}
        </div>
      )}

      {/* Auto-restart note */}
      {previewLabel && (
        <div className="text-[10px] text-muted-foreground pl-0.5">
          Auto-restart po każdym zakończeniu pracy agenta (label: {previewLabel})
        </div>
      )}

      {/* Error message */}
      {runtime?.status === "FAILED" && runtime.error && (
        <pre className="text-[10px] text-destructive whitespace-pre-wrap bg-destructive/10 rounded px-2 py-1 max-h-20 overflow-auto font-mono">
          {runtime.error}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    STARTING: "bg-yellow-500 animate-pulse",
    DEPLOYING: "bg-yellow-500 animate-pulse",
    RUNNING: "bg-green-500",
    FAILED: "bg-red-500",
    STOPPED: "bg-gray-500",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] text-white font-mono ${colors[status] || "bg-gray-500"}`}>
      {status === "DEPLOYING" ? "Deploying..." : status === "STARTING" ? "Starting..." : status.toLowerCase()}
    </span>
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

function StopButton({ onStop, isStopping, supabaseUrl, branch }: {
  onStop: () => void;
  isStopping: boolean;
  supabaseUrl?: string | null;
  branch?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 text-[10px] px-2 text-muted-foreground"
        onClick={() => setOpen(true)}
        disabled={isStopping}
      >
        Stop
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Stop remote preview
            </DialogTitle>
            <DialogDescription>
              This will permanently remove all remote preview resources for branch{" "}
              <code className="bg-muted px-1 rounded">{branch}</code>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {supabaseUrl && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 space-y-1">
                <p className="text-sm font-medium text-destructive">Supabase branch will be deleted</p>
                <p className="text-sm text-muted-foreground">
                  Database <code className="bg-muted px-1 rounded text-foreground">{supabaseUrl}</code> and all its data will be <span className="font-medium text-destructive">permanently removed</span>. This cannot be undone.
                </p>
              </div>
            )}

            <div className="rounded-md border border-border bg-muted/50 p-3">
              <p className="text-sm text-muted-foreground">
                Netlify branch deploys will be stopped. The deploy URLs will no longer be accessible.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => { setOpen(false); onStop(); }}
              disabled={isStopping}
            >
              {isStopping && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Delete & Stop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin -ml-0.5 mr-1.5 h-3 w-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

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
    const interval = setInterval(check, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [url]);

  if (status === "loading") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-600 text-white text-[10px] font-mono cursor-default">
        <Spinner />
        {label}
      </span>
    );
  }

  if (status === "down") {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white text-[10px] font-mono transition-colors">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-300" />
        {label}
      </a>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-600 hover:bg-green-500 text-white text-[10px] font-mono transition-colors">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse" />
      {label}
    </a>
  );
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pl-PL", {
      timeZone: "Europe/Warsaw",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function extractSiteName(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split("--");
    if (parts.length >= 2) {
      return parts.slice(1).join("--").replace(".netlify.app", "");
    }
    return hostname.replace(".netlify.app", "");
  } catch {
    return url;
  }
}
