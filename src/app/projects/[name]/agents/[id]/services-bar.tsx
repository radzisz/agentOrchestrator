"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RotateCcw, ChevronDown, ChevronRight, Play, ExternalLink } from "lucide-react";
import { ServiceLink } from "@/components/service-link";

interface ServiceConfig {
  name: string;
  cmd: string;
  port: number;
}

export function ServicesBar({
  projectName,
  issueId,
  runtimeId,
  cfgServices,
  initialEnabled,
}: {
  projectName: string;
  issueId: string;
  runtimeId: string;
  cfgServices: ServiceConfig[];
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [runtimeStatus, setRuntimeStatus] = useState<string>("STOPPED");
  const [serviceLinks, setServiceLinks] = useState<Array<{ name: string; hostPort: number; healthPath?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const togglingRef = useRef(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [mode, setMode] = useState<"container" | "host">("container");
  const [activeMode, setActiveMode] = useState<"container" | "host">("container");
  const [targetInfo, setTargetInfo] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    if (togglingRef.current) return; // don't override optimistic UI during start/stop
    try {
      const resp = await fetch(`/api/projects/${projectName}/agents/${issueId}/services`);
      if (!resp.ok) return;
      const data = await resp.json();
      setEnabled(data.servicesEnabled);
      setRuntimeStatus(data.runtimeStatus);
      setError(data.error);
      if (data.mode) setActiveMode(data.mode);
      setTargetInfo(data.mode === "host" ? data.agentDir : data.containerName);
      setServiceLinks(data.servicePortMap?.length > 0 ? data.servicePortMap : []);
    } catch {
      // silent
    }
  }, [projectName, issueId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  async function handleStart() {
    setToggling(true);
    togglingRef.current = true;
    setEnabled(true);
    setError(null);
    setRuntimeStatus("STARTING");
    setActiveMode(mode);
    try {
      const resp = await fetch(`/api/projects/${projectName}/agents/${issueId}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, mode }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        setError(data.error || "Failed");
        setEnabled(false);
        setRuntimeStatus("STOPPED");
      }
    } catch {
      setEnabled(false);
      setRuntimeStatus("STOPPED");
    } finally {
      setToggling(false);
      togglingRef.current = false;
    }
  }

  async function handleStop() {
    setToggling(true);
    togglingRef.current = true;
    try {
      await fetch(`/api/projects/${projectName}/agents/${issueId}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      setEnabled(false);
      setRuntimeStatus("STOPPED");
      setServiceLinks([]);
    } catch {
      // poll will pick up
    } finally {
      setToggling(false);
      togglingRef.current = false;
    }
  }

  const isFailed = runtimeStatus === "FAILED";
  const isStopped = runtimeStatus === "STOPPED";
  const isStarting = runtimeStatus === "STARTING";
  const isRunning = !isStopped && !isFailed && !isStarting && enabled;
  const isPartial = isFailed && enabled && serviceLinks.length > 0; // some services up, some failed
  const hasServices = serviceLinks.length > 0;

  const statusColor = isPartial ? "text-orange-500" : isFailed ? "text-red-500" : isRunning && hasServices ? "text-green-500" : isStarting ? "text-yellow-500" : "text-muted-foreground";
  const statusText = isPartial ? "partial" : isFailed ? "failed" : isRunning && hasServices ? "running" : isStarting ? "starting" : "stopped";

  return (
    <div className="space-y-1">
      {/* Main line */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Preview</span>
        <span className={`font-mono font-medium ${statusColor}`}>{statusText}</span>

        {/* Service links — show as soon as port map is available (including during starting) */}
        {enabled && hasServices && (
          <div className="flex items-center gap-1 ml-1">
            {serviceLinks.map((link) => (
              <ServiceLink
                key={link.name}
                name={link.name}
                port={link.hostPort}
                runtimeId={runtimeId}
                healthPath={link.healthPath}
              />
            ))}
          </div>
        )}

        {/* Placeholder badges from config while port map not yet known */}
        {enabled && !hasServices && isStarting && cfgServices.length > 0 && (
          <div className="flex items-center gap-1 ml-1">
            {cfgServices.map((svc) => (
              <span
                key={svc.name}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-700 text-zinc-400 text-xs font-mono"
                title={svc.cmd}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-500" />
                {svc.name}
              </span>
            ))}
          </div>
        )}

        {/* Mode indicator when active */}
        {enabled && !isStopped && (
          <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px]" title={targetInfo || undefined}>
            [{activeMode}{targetInfo ? `: ${activeMode === "host" ? targetInfo.split(/[\\/]/).slice(-2).join("/") : targetInfo}` : ""}]
          </span>
        )}

        {/* Action buttons inline */}
        {toggling && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}

        {/* Mode toggle + Start — show when fully stopped / never started */}
        {!enabled && !toggling && (
          <div className="flex items-center gap-1">
            <div className="inline-flex rounded border border-border overflow-hidden h-5 text-[10px]">
              <button
                className={`px-1.5 ${mode === "container" ? "bg-zinc-700 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setMode("container")}
              >
                Container
              </button>
              <button
                className={`px-1.5 ${mode === "host" ? "bg-zinc-700 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setMode("host")}
              >
                Host
              </button>
            </div>
            <Button variant="outline" size="sm" className="h-5 text-[10px] px-2" onClick={handleStart}>
              <Play className="h-2.5 w-2.5 mr-1" />Start
            </Button>
          </div>
        )}

        {/* Partial/failed: Stop (kill what's running) + Restart (with mode toggle) */}
        {enabled && (isFailed || isStopped) && !toggling && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-5 text-[10px] px-2 text-muted-foreground" onClick={handleStop}>
              Stop
            </Button>
            <div className="inline-flex rounded border border-border overflow-hidden h-5 text-[10px]">
              <button
                className={`px-1.5 ${mode === "container" ? "bg-zinc-700 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setMode("container")}
              >
                Container
              </button>
              <button
                className={`px-1.5 ${mode === "host" ? "bg-zinc-700 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setMode("host")}
              >
                Host
              </button>
            </div>
            <Button variant="outline" size="sm" className="h-5 text-[10px] px-2" onClick={handleStart}>
              <RotateCcw className="h-2.5 w-2.5 mr-1" />Restart
            </Button>
          </div>
        )}

        {/* Running/starting: just Stop */}
        {enabled && (isRunning || isStarting) && !toggling && (
          <Button variant="ghost" size="sm" className="h-5 text-[10px] px-2 text-muted-foreground" onClick={handleStop}>
            Stop
          </Button>
        )}

        {/* Config toggle */}
        {cfgServices.length > 0 && (
          <button
            onClick={() => setConfigOpen(!configOpen)}
            className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground ml-auto"
          >
            {configOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Configure
          </button>
        )}
      </div>

      {/* Error */}
      {isFailed && error && (
        <pre className="text-[10px] text-destructive whitespace-pre-wrap bg-destructive/10 rounded px-2 py-1 max-h-20 overflow-auto font-mono">
          {error}
        </pre>
      )}

      {/* Config details (expandable) */}
      {configOpen && (
        <div className="pl-4 space-y-0.5">
          {cfgServices.map((svc) => (
            <div key={svc.name} className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono">{svc.name}</span>
              <span className="opacity-50">→</span>
              <span className="font-mono opacity-75 truncate">{svc.cmd}</span>
              <span className="opacity-50">:{svc.port}</span>
            </div>
          ))}
          <a
            href={`/projects/${projectName}#runtime`}
            className="inline-block text-[10px] text-muted-foreground hover:text-foreground underline mt-1"
          >
            Edit in project settings
          </a>
        </div>
      )}
    </div>
  );
}
