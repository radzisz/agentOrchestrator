"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Container, Loader2 } from "lucide-react";

interface ContainerStatus {
  running: boolean;
  containerName: string | null;
  status?: string;
}

export function ContainerCard({
  projectName,
  issueId,
  containerName,
}: {
  projectName: string;
  issueId: string;
  containerName: string | null;
}) {
  const [status, setStatus] = useState<ContainerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function fetchStatus() {
    try {
      const resp = await fetch(
        `/api/projects/${projectName}/agents/${issueId}/container`
      );
      if (resp.ok) {
        setStatus(await resp.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [projectName, issueId]);

  async function handleAction(action: "start" | "stop") {
    setBusy(action);
    try {
      const resp = await fetch(
        `/api/projects/${projectName}/agents/${issueId}/container`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      );
      if (!resp.ok) {
        const data = await resp.json();
        console.error("[container]", data.error);
      }
      await fetchStatus();
    } catch (err) {
      console.error("[container]", err);
    } finally {
      setBusy(null);
    }
  }

  const running = status?.running ?? false;
  const rawStatus = status?.status || (loading ? "checking..." : "unknown");
  const dockerStatus = rawStatus === "not found" || rawStatus === "exited" ? "stopped" : rawStatus;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Container className={`h-4 w-4 ${running ? "text-green-500" : "text-muted-foreground"}`} />
            Container
          </CardTitle>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : (
            <Badge
              className={`${running ? "bg-green-500" : "bg-gray-400"} text-white border-0 text-[10px]`}
            >
              {dockerStatus}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-between">
        <p className="text-sm font-mono text-muted-foreground truncate">
          {containerName || "No container"}
        </p>
        <div className="flex justify-end mt-3">
          {running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAction("stop")}
              disabled={busy === "stop"}
            >
              {busy === "stop" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Stop
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAction("start")}
              disabled={busy === "start"}
            >
              {busy === "start" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Start
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
