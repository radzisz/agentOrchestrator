"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SpawnButton } from "./spawn-button";
import { BranchesPanel } from "./branches-panel";
import { LocalBranchesPanel } from "./local-branches-panel";
import { RuntimeConfig, type RuntimeConfigData } from "./runtime-config";
import { RemoteConfig, type RemoteConfigData } from "./remote-config";
import { SentryMapping } from "./sentry-mapping";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Tab = "local" | "remote" | "integrations";

interface ProjectData {
  name: string;
  repoPath: string | null;
  repoUrl: string | null;
  linearApiKey: string | null;
  linearTeamKey: string | null;
  linearLabel: string;
  githubToken: string | null;
  supabaseAccessToken: string | null;
  supabaseProjectRef: string | null;
  netlifyAuthToken: string | null;
  netlifySites: Array<{ name: string; siteName: string }>;
  sentryProjects: string[];
  runtimeConfig: RuntimeConfigData | null;
  runtimeModes: { local: boolean; remote: boolean };
}

export function ProjectTabs({
  project,
  agents,
}: {
  project: ProjectData;
  agents: any[];
}) {
  const [tab, setTab] = useState<Tab>("local");
  const [modes, setModes] = useState(project.runtimeModes);

  async function toggleMode(mode: "local" | "remote") {
    const updated = { ...modes, [mode]: !modes[mode] };
    setModes(updated);
    try {
      const resp = await fetch(`/api/projects/${project.name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtimeModes: updated }),
      });
      if (!resp.ok) throw new Error("Save failed");
      toast.success(`${mode === "local" ? "Local" : "Remote"} ${updated[mode] ? "enabled" : "disabled"}`);
    } catch {
      toast.error("Failed to save");
      setModes(modes); // revert
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        <div className="px-6 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <p className="text-muted-foreground text-sm">{project.repoPath || project.repoUrl}</p>
          </div>
          <SpawnButton projectName={project.name} />
        </div>

        {/* Tabs */}
        <div className="px-6 flex gap-0">
          {(["local", "remote", "integrations"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "local" ? "Local" : t === "remote" ? "Remote" : "Integrations"}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="p-6">
        {tab === "local" && (
          <LocalTab
            project={project}
            modes={modes}
            onToggle={() => toggleMode("local")}
          />
        )}
        {tab === "remote" && (
          <RemoteTab
            project={project}
            modes={modes}
            onToggle={() => toggleMode("remote")}
          />
        )}
        {tab === "integrations" && (
          <IntegrationsTab project={project} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local Tab
// ---------------------------------------------------------------------------

function LocalTab({
  project,
  modes,
  onToggle,
}: {
  project: ProjectData;
  modes: { local: boolean; remote: boolean };
  onToggle: () => void;
}) {
  return (
    <div className="space-y-6">
      <RuntimeConfig
        projectName={project.name}
        initialConfig={project.runtimeConfig}
        enabled={modes.local}
        onToggle={onToggle}
      />

      <LocalBranchesPanel
        projectName={project.name}
        linearConfigured={!!(project.linearApiKey && project.linearTeamKey)}
        linearTeamKey={project.linearTeamKey}
        linearLabel={project.linearLabel}
        githubConfigured={!!project.githubToken}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remote Tab
// ---------------------------------------------------------------------------

function RemoteTab({
  project,
  modes,
  onToggle,
}: {
  project: ProjectData;
  modes: { local: boolean; remote: boolean };
  onToggle: () => void;
}) {
  return (
    <div className="space-y-6">
      <RemoteConfig
        projectName={project.name}
        initialData={{
          supabaseAccessToken: project.supabaseAccessToken,
          supabaseProjectRef: project.supabaseProjectRef,
          netlifyAuthToken: project.netlifyAuthToken,
          netlifySites: project.netlifySites,
        }}
        enabled={modes.remote}
        onToggle={onToggle}
      />

      <BranchesPanel projectName={project.name} runtimeType="REMOTE" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integrations Tab
// ---------------------------------------------------------------------------

function IntegrationsTab({ project }: { project: ProjectData }) {
  const [linearApiKey, setLinearApiKey] = useState(project.linearApiKey || "");
  const [linearTeamKey, setLinearTeamKey] = useState(project.linearTeamKey || "");
  const [linearLabel, setLinearLabel] = useState(project.linearLabel);
  const [githubToken, setGithubToken] = useState(project.githubToken || "");
  const [saving, setSaving] = useState<string | null>(null);

  async function saveField(field: string, value: string) {
    setSaving(field);
    try {
      const resp = await fetch(`/api/projects/${project.name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value || null }),
      });
      if (!resp.ok) throw new Error("Save failed");
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Linear */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Linear</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">API Key</label>
            <div className="flex gap-2">
              <input
                className="flex-1 px-2 py-1 text-sm border rounded bg-background font-mono"
                type="password"
                value={linearApiKey}
                onChange={(e) => setLinearApiKey(e.target.value)}
                placeholder="lin_api_..."
              />
              <Button
                size="sm"
                variant="outline"
                disabled={saving === "linearApiKey"}
                onClick={() => saveField("linearApiKey", linearApiKey)}
              >
                {saving === "linearApiKey" ? "..." : "Save"}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Team Key</label>
              <div className="flex gap-2">
                <input
                  className="flex-1 px-2 py-1 text-sm border rounded bg-background"
                  value={linearTeamKey}
                  onChange={(e) => setLinearTeamKey(e.target.value)}
                  placeholder="UKR"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving === "linearTeamKey"}
                  onClick={() => saveField("linearTeamKey", linearTeamKey)}
                >
                  {saving === "linearTeamKey" ? "..." : "Save"}
                </Button>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Label</label>
              <div className="flex gap-2">
                <input
                  className="flex-1 px-2 py-1 text-sm border rounded bg-background"
                  value={linearLabel}
                  onChange={(e) => setLinearLabel(e.target.value)}
                  placeholder="agent"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving === "linearLabel"}
                  onClick={() => saveField("linearLabel", linearLabel)}
                >
                  {saving === "linearLabel" ? "..." : "Save"}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* GitHub */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">GitHub</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="text-xs text-muted-foreground block mb-1">Token</label>
          <div className="flex gap-2">
            <input
              className="flex-1 px-2 py-1 text-sm border rounded bg-background font-mono"
              type="password"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              placeholder="ghp_..."
            />
            <Button
              size="sm"
              variant="outline"
              disabled={saving === "githubToken"}
              onClick={() => saveField("githubToken", githubToken)}
            >
              {saving === "githubToken" ? "..." : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Sentry */}
      <SentryMapping
        projectName={project.name}
        initialProjects={project.sentryProjects}
      />
    </div>
  );
}
