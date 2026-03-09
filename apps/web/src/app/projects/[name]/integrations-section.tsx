"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RuntimeConfig, type RuntimeConfigData } from "./runtime-config";
import { RemoteConfig, type ProjectRtenvConfig } from "./remote-config";
import { SentryMapping } from "./sentry-mapping";

export interface RuntimeModes {
  local: boolean;
  remote: boolean;
}

export function IntegrationsSection({
  projectName,
  linearTeamKey,
  linearLabel,
  linearPreviewLabel,
  githubToken,
  runtimeConfig,
  rtenvConfig,
  sentryProjects,
  initialRuntimeModes,
}: {
  projectName: string;
  linearTeamKey: string;
  linearLabel: string;
  linearPreviewLabel: string;
  githubToken: string | null;
  runtimeConfig: RuntimeConfigData | null;
  rtenvConfig: ProjectRtenvConfig;
  sentryProjects: string[];
  initialRuntimeModes: RuntimeModes;
}) {
  const [open, setOpen] = useState(false);
  const [modes, setModes] = useState<RuntimeModes>(initialRuntimeModes);

  async function toggleMode(mode: "local" | "remote") {
    const updated = { ...modes, [mode]: !modes[mode] };
    setModes(updated);
    await fetch(`/api/projects/${projectName}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeModes: updated }),
    });
  }

  return (
    <div>
      <button
        className="flex items-center gap-2 w-full text-left mb-3"
        onClick={() => setOpen(!open)}
      >
        <svg
          className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        <h2 className="text-lg font-semibold">Integrations</h2>
        {!open && (
          <span className="text-xs text-muted-foreground ml-2">
            Linear ({linearTeamKey})
            {githubToken ? " · GitHub" : ""}
            {rtenvConfig.supabase?.enabled ? " · Supabase" : ""}
            {rtenvConfig.netlify?.enabled ? " · Netlify" : ""}
            {rtenvConfig.vercel?.enabled ? " · Vercel" : ""}
            {sentryProjects.length > 0 ? " · Sentry" : ""}
            {modes.local ? " · Local" : ""}
            {modes.remote ? " · Remote" : ""}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Linear</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div>Team Key: {linearTeamKey}</div>
                  <div>Label: {linearLabel}</div>
                  {linearPreviewLabel && <div>Preview Label: {linearPreviewLabel}</div>}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">GitHub</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="text-xs text-muted-foreground">
                  Token: {githubToken ? "***" : "Not set"}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <RuntimeConfig
              projectName={projectName}
              initialConfig={runtimeConfig}
              enabled={modes.local}
              onToggle={() => toggleMode("local")}
            />
            <RemoteConfig
              projectName={projectName}
              initialRtenvConfig={rtenvConfig}
              enabled={modes.remote}
              onToggle={() => toggleMode("remote")}
            />
            <SentryMapping
              projectName={projectName}
              initialProjects={sentryProjects}
            />
          </div>
        </div>
      )}
    </div>
  );
}
