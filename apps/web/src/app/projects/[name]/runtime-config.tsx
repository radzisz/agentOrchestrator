"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface RuntimeConfigData {
  image?: string;        // Docker image (default: node:22-slim)
  installCmd?: string;   // e.g. "npm install" or "pnpm install"
  buildCmd?: string;     // e.g. "npm run build" — runs after install, before services
  envVars?: string;      // KEY=VALUE per line, passed to all services
  services: Array<{
    name: string;        // e.g. "guide", "panel", "admin"
    cmd: string;         // e.g. "npm -w @ukryteskarby-pl/app_guide run dev:noWatch"
    port: number;        // port inside container, e.g. 3000, 3001, 3002
    healthPath?: string; // path for health check, e.g. "/guide" (default: "/")
    portVar?: string;    // env var name for host-mode dynamic port, e.g. "PORT_NUMBER_GUIDE"
  }>;
}

const DEFAULT_CONFIG: RuntimeConfigData = {
  image: "node:22-slim",
  installCmd: "npm install",
  services: [{ name: "dev", cmd: "npm run dev", port: 3000 }],
};

export function RuntimeConfig({
  projectName,
  initialConfig,
  enabled,
  onToggle,
}: {
  projectName: string;
  initialConfig: RuntimeConfigData | null;
  enabled: boolean;
  onToggle: () => void;
}) {
  const [config, setConfig] = useState<RuntimeConfigData>(
    initialConfig || DEFAULT_CONFIG
  );
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  // Auto-open when navigated with #runtime hash, then clear hash
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#runtime") {
      setOpen(true);
      setTimeout(() => {
        document.getElementById("runtime")?.scrollIntoView({ behavior: "smooth" });
        // Clear hash so refresh doesn't re-open
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }, 100);
    }
  }, []);

  async function save() {
    setSaving(true);
    try {
      const resp = await fetch(`/api/projects/${projectName}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtimeConfig: config }),
      });
      if (!resp.ok) throw new Error("Save failed");
      toast.success("Runtime config saved");
    } catch {
      toast.error("Failed to save runtime config");
    } finally {
      setSaving(false);
    }
  }

  function updateService(idx: number, field: string, value: string | number) {
    const updated = [...config.services];
    updated[idx] = { ...updated[idx], [field]: value };
    setConfig({ ...config, services: updated });
  }

  function addService() {
    setConfig({
      ...config,
      services: [
        ...config.services,
        { name: "", cmd: "", port: 3000 + config.services.length },
      ],
    });
  }

  function removeService(idx: number) {
    setConfig({
      ...config,
      services: config.services.filter((_, i) => i !== idx),
    });
  }

  if (!open) {
    return (
      <Card id="runtime" className={!enabled ? "opacity-50" : ""}>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              className={`w-8 h-4 rounded-full transition-colors relative ${enabled ? "bg-green-500" : "bg-muted"}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? "left-4" : "left-0.5"}`} />
            </button>
            <CardTitle className="text-sm">Local Runtime</CardTitle>
          </div>
          {enabled && (
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              {initialConfig ? "Edit" : "Configure"}
            </Button>
          )}
        </CardHeader>
        {enabled && initialConfig && (
          <CardContent className="pt-0">
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>Image: {initialConfig.image || "node:22-slim"}</div>
              <div>Install: {initialConfig.installCmd || "npm install"}</div>
              {initialConfig.buildCmd && <div>Build: {initialConfig.buildCmd}</div>}
              {initialConfig.envVars && (
                <div>Env: {initialConfig.envVars.split("\n").filter(l => l.trim()).length} vars</div>
              )}
              <div>
                Services:{" "}
                {initialConfig.services
                  .map((s) => s.name)
                  .join(", ")}
              </div>
            </div>
          </CardContent>
        )}
      </Card>
    );
  }

  return (
    <Card id="runtime">
      <CardHeader className="flex flex-row items-center gap-2 py-3">
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className={`w-8 h-4 rounded-full transition-colors relative ${enabled ? "bg-green-500" : "bg-muted"}`}
        >
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? "left-4" : "left-0.5"}`} />
        </button>
        <CardTitle className="text-sm">Local Runtime</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Image */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Docker Image
          </label>
          <input
            className="w-full px-2 py-1 text-sm border rounded bg-background"
            value={config.image || ""}
            onChange={(e) => setConfig({ ...config, image: e.target.value })}
            placeholder="node:22-slim"
          />
        </div>

        {/* Install command */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Install Command
          </label>
          <input
            className="w-full px-2 py-1 text-sm border rounded bg-background"
            value={config.installCmd || ""}
            onChange={(e) =>
              setConfig({ ...config, installCmd: e.target.value })
            }
            placeholder="npm install"
          />
        </div>

        {/* Build command */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Build Command (after install, before services)
          </label>
          <input
            className="w-full px-2 py-1 text-sm border rounded bg-background"
            value={config.buildCmd || ""}
            onChange={(e) =>
              setConfig({ ...config, buildCmd: e.target.value })
            }
            placeholder="npm run build (optional)"
          />
        </div>

        {/* Environment Variables */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Environment Variables (KEY=VALUE per line)
          </label>
          <textarea
            className="w-full px-2 py-1 text-sm border rounded bg-background font-mono min-h-[60px]"
            value={config.envVars || ""}
            onChange={(e) => setConfig({ ...config, envVars: e.target.value })}
            placeholder={"PUBLIC_FUNCTIONS_BASE_PATH=/api\nNODE_ENV=development"}
            rows={3}
          />
        </div>

        {/* Services */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-muted-foreground">Services</label>
            <Button variant="ghost" size="sm" onClick={addService}>
              + Add
            </Button>
          </div>

          <div className="space-y-2">
            {config.services.map((svc, idx) => (
              <div
                key={idx}
                className="grid grid-cols-[1fr_3fr_1.2fr_1fr_auto] gap-2 items-center"
              >
                <input
                  className="px-2 py-1 text-sm border rounded bg-background"
                  value={svc.name}
                  onChange={(e) => updateService(idx, "name", e.target.value)}
                  placeholder="name"
                />
                <input
                  className="px-2 py-1 text-sm border rounded bg-background font-mono"
                  value={svc.cmd}
                  onChange={(e) => updateService(idx, "cmd", e.target.value)}
                  placeholder="npm run dev -- --port 3000"
                />
                <input
                  className="px-2 py-1 text-sm border rounded bg-background font-mono"
                  value={svc.portVar || ""}
                  onChange={(e) => updateService(idx, "portVar", e.target.value)}
                  placeholder="PORT_NUMBER_XXX"
                  title="Port variable name for host mode (optional). Service gets a free port via this env var."
                />
                <input
                  className="px-2 py-1 text-sm border rounded bg-background font-mono"
                  value={svc.healthPath || ""}
                  onChange={(e) => updateService(idx, "healthPath", e.target.value)}
                  placeholder="/"
                  title="Health check path (default: /)"
                />
                {config.services.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeService(idx)}
                    className="text-destructive px-2"
                  >
                    x
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfig(initialConfig || DEFAULT_CONFIG);
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
