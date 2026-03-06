"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Loader2, RotateCcw } from "lucide-react";
import { ServiceLink } from "@/components/service-link";

interface ServiceConfig {
  name: string;
  cmd: string;
  port: number;
}

export function ServicesCard({
  projectName,
  issueId,
  branch,
  runtimeId,
  cfgServices,
  initialEnabled,
  onShowLogs,
}: {
  projectName: string;
  issueId: string;
  branch: string;
  runtimeId: string;
  cfgServices: ServiceConfig[];
  initialEnabled: boolean;
  onShowLogs?: () => void;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [runtimeStatus, setRuntimeStatus] = useState<string>("STOPPED");
  const [serviceLinks, setServiceLinks] = useState<Array<{ name: string; hostPort: number; healthPath?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const resp = await fetch(`/api/projects/${projectName}/agents/${issueId}/services`);
      if (!resp.ok) return;
      const data = await resp.json();
      setEnabled(data.servicesEnabled);
      setRuntimeStatus(data.runtimeStatus);
      setError(data.error);

      if (data.servicePortMap && data.servicePortMap.length > 0) {
        setServiceLinks(data.servicePortMap);
      }
    } catch {
      // silent
    }
  }, [projectName, issueId, cfgServices]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  async function handleToggle(newValue: boolean) {
    setToggling(true);
    setEnabled(newValue);
    setError(null);
    if (newValue) setRuntimeStatus("STARTING");
    try {
      const resp = await fetch(`/api/projects/${projectName}/agents/${issueId}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newValue }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        setError(data.error || "Failed");
        setEnabled(!newValue);
        if (newValue) setRuntimeStatus("STOPPED");
      }
    } catch {
      setEnabled(!newValue);
      if (newValue) setRuntimeStatus("STOPPED");
    } finally {
      setToggling(false);
    }
  }

  async function handleRetry() {
    setError(null);
    setRuntimeStatus("STARTING");
    try {
      await fetch(`/api/projects/${projectName}/agents/${issueId}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
    } catch {
      // poll will pick up status
    }
  }

  const isFailed = runtimeStatus === "FAILED";
  const isStopped = runtimeStatus === "STOPPED";
  const hasServices = serviceLinks.length > 0;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Services</CardTitle>
          <div className="flex items-center gap-2">
            {toggling && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={toggling}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-between space-y-3">
        <div className="space-y-2">
          {!enabled && (
            <p className="text-xs text-muted-foreground">Services disabled. Enable to auto-start with container.</p>
          )}

          {/* Show individual services as soon as we know their ports */}
          {enabled && hasServices && (
            <div className="flex flex-wrap gap-1">
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

          {/* Show config-based placeholders while port map not yet known */}
          {enabled && !hasServices && !isStopped && !isFailed && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Starting services...
              </div>
              {cfgServices.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {cfgServices.map((svc) => (
                    <span
                      key={svc.name}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-700 text-zinc-400 text-xs font-mono"
                      title={`${svc.cmd} (waiting for port allocation)`}
                    >
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-500" />
                      {svc.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {enabled && isFailed && error && (
            <pre className="text-xs text-destructive whitespace-pre-wrap bg-destructive/10 rounded p-2 max-h-32 overflow-auto font-mono">
              {error}
            </pre>
          )}

          {enabled && isStopped && !hasServices && (
            <p className="text-xs text-muted-foreground">Services exited.</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <a
            href={`/projects/${projectName}#runtime`}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Configure
          </a>
          {enabled && onShowLogs && (
            <button
              onClick={onShowLogs}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Logs
            </button>
          )}
          {enabled && (isFailed || isStopped) && (
            <Button variant="outline" size="sm" onClick={handleRetry}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              {isFailed ? "Retry" : "Restart"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
