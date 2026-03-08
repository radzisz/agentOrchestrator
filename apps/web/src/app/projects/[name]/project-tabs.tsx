"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { SpawnButton } from "./spawn-button";
import { BranchesPanel } from "./branches-panel";
import { LocalBranchesPanel } from "./local-branches-panel";
import { RuntimeConfig, type RuntimeConfigData } from "./runtime-config";
import { RemoteConfig, type RemoteConfigData } from "./remote-config";
import { TrackerSettings } from "./tracker-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Tab = "local" | "remote" | "integrations";

interface ProjectData {
  name: string;
  repoPath: string | null;
  repoUrl: string | null;
  trackerConfigured: boolean;
  trackerTeamKey: string | null;
  trackerLabel: string;
  trackerPreviewLabel: string;
  repoProviderInstanceId: string | null;
  supabaseAccessToken: string | null;
  supabaseProjectRef: string | null;
  netlifyAuthToken: string | null;
  netlifySites: Array<{ name: string; siteName: string }>;
  runtimeConfig: RuntimeConfigData | null;
  runtimeModes: { local: boolean; remote: boolean };
  aiProviderInstanceId: string | null;
  imProviderInstanceId: string | null;
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
          {(["local", "remote", "integrations"] as Tab[]).map((t) => {
            const needsSetup = t === "integrations" && !project.repoUrl;
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                  tab === t
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "local" ? "Local" : t === "remote" ? "Remote" : "Integrations"}
                {needsSetup && (
                  <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="Needs configuration" />
                )}
              </button>
            );
          })}
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
  const [repoConfigured, setRepoConfigured] = useState(false);

  useEffect(() => {
    fetch("/api/repo-providers")
      .then((r) => r.json())
      .then((data) => {
        const instances = data.instances || [];
        if (project.repoProviderInstanceId) {
          setRepoConfigured(instances.some((i: any) => i.id === project.repoProviderInstanceId));
        } else {
          setRepoConfigured(instances.some((i: any) => i.isDefault));
        }
      })
      .catch(() => {});
  }, [project.repoProviderInstanceId]);

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
        linearConfigured={project.trackerConfigured}
        linearTeamKey={project.trackerTeamKey}
        linearLabel={project.trackerLabel}
        githubConfigured={repoConfigured}
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
// Status Badge
// ---------------------------------------------------------------------------

function StatusBadge({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
      ok
        ? "bg-green-500/15 text-green-600 dark:text-green-400"
        : "bg-red-500/15 text-red-600 dark:text-red-400"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`} />
      {label || (ok ? "Configured" : "Needs setup")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AI Provider Picker
// ---------------------------------------------------------------------------

interface AIProviderInstanceData {
  id: string;
  type: string;
  name: string;
  isDefault: boolean;
  config: Record<string, string>;
}

function AIProviderPicker({
  project,
  saveField,
}: {
  project: ProjectData;
  saveField: (field: string, value: string) => Promise<void>;
}) {
  const [instances, setInstances] = useState<AIProviderInstanceData[]>([]);
  const [mode, setMode] = useState<"default" | "specific">(project.aiProviderInstanceId ? "specific" : "default");
  const [selected, setSelected] = useState(project.aiProviderInstanceId || "");

  useEffect(() => {
    fetch("/api/ai-providers")
      .then((r) => r.json())
      .then((data) => setInstances(data.instances || []))
      .catch(() => {});
  }, []);

  const defaultInst = instances.find((i) => i.isDefault);
  const isConfigured = !!(project.aiProviderInstanceId
    ? instances.find((i) => i.id === project.aiProviderInstanceId)
    : defaultInst);

  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">AI Provider</CardTitle>
          <StatusBadge ok={isConfigured} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="aiProviderMode"
            checked={mode === "default"}
            onChange={() => {
              setMode("default");
              setSelected("");
              saveField("aiProviderInstanceId", "");
            }}
            className="accent-primary"
          />
          <span className="text-sm">System default</span>
          {defaultInst && (
            <span className="text-xs text-muted-foreground">
              ({defaultInst.name}{defaultInst.config.model ? ` / ${defaultInst.config.model}` : ""})
            </span>
          )}
          {!defaultInst && instances.length === 0 && (
            <span className="text-xs text-muted-foreground">(not configured)</span>
          )}
        </label>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="aiProviderMode"
            checked={mode === "specific"}
            onChange={() => setMode("specific")}
            className="accent-primary"
          />
          <span className="text-sm">Specific instance</span>
        </label>

        {mode === "specific" && (
          <div className="pl-5">
            {instances.length > 0 ? (
              <select
                className="w-full px-2 py-1 text-sm border rounded bg-background"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  saveField("aiProviderInstanceId", e.target.value);
                }}
              >
                <option value="">Select...</option>
                {instances.map((inst) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.name} ({inst.type}){inst.config.model ? ` — ${inst.config.model}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">
                No instances configured. <a href="/integrations" className="underline">Add one</a>.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// IM Provider Picker
// ---------------------------------------------------------------------------

interface IMProviderInstanceData {
  id: string;
  type: string;
  name: string;
  isDefault: boolean;
  config: Record<string, string>;
}

function IMProviderPicker({
  project,
  saveField,
}: {
  project: ProjectData;
  saveField: (field: string, value: string) => Promise<void>;
}) {
  const [instances, setInstances] = useState<IMProviderInstanceData[]>([]);
  const [mode, setMode] = useState<"default" | "specific">(project.imProviderInstanceId ? "specific" : "default");
  const [selected, setSelected] = useState(project.imProviderInstanceId || "");

  useEffect(() => {
    fetch("/api/im-providers")
      .then((r) => r.json())
      .then((data) => setInstances(data.instances || []))
      .catch(() => {});
  }, []);

  const defaultInst = instances.find((i) => i.isDefault);
  const isConfigured = !!(project.imProviderInstanceId
    ? instances.find((i) => i.id === project.imProviderInstanceId)
    : defaultInst);

  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Instant Messaging</CardTitle>
          <StatusBadge ok={isConfigured} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="imProviderMode"
            checked={mode === "default"}
            onChange={() => {
              setMode("default");
              setSelected("");
              saveField("imProviderInstanceId", "");
            }}
            className="accent-primary"
          />
          <span className="text-sm">System default</span>
          {defaultInst && (
            <span className="text-xs text-muted-foreground">
              ({defaultInst.name}{defaultInst.config.chatId ? ` / ${defaultInst.config.chatId}` : ""})
            </span>
          )}
          {!defaultInst && instances.length === 0 && (
            <span className="text-xs text-muted-foreground">(not configured)</span>
          )}
        </label>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="imProviderMode"
            checked={mode === "specific"}
            onChange={() => setMode("specific")}
            className="accent-primary"
          />
          <span className="text-sm">Specific instance</span>
        </label>

        {mode === "specific" && (
          <div className="pl-5">
            {instances.length > 0 ? (
              <select
                className="w-full px-2 py-1 text-sm border rounded bg-background"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  saveField("imProviderInstanceId", e.target.value);
                }}
              >
                <option value="">Select...</option>
                {instances.map((inst) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.name} ({inst.type}){inst.config.chatId ? ` — ${inst.config.chatId}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">
                No instances configured. <a href="/integrations" className="underline">Add one</a>.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Repo Provider Picker
// ---------------------------------------------------------------------------

interface RepoProviderInstanceData {
  id: string;
  type: string;
  name: string;
  isDefault: boolean;
  config: Record<string, string>;
}

function RepoProviderPicker({
  project,
  saveField,
}: {
  project: ProjectData;
  saveField: (field: string, value: string) => Promise<void>;
}) {
  const [instances, setInstances] = useState<RepoProviderInstanceData[]>([]);
  const [mode, setMode] = useState<"default" | "specific">(project.repoProviderInstanceId ? "specific" : "default");
  const [selected, setSelected] = useState(project.repoProviderInstanceId || "");

  useEffect(() => {
    fetch("/api/repo-providers")
      .then((r) => r.json())
      .then((data) => setInstances(data.instances || []))
      .catch(() => {});
  }, []);

  const defaultInst = instances.find((i) => i.isDefault);
  const isConfigured = !!(project.repoProviderInstanceId
    ? instances.find((i) => i.id === project.repoProviderInstanceId)
    : defaultInst);

  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Source Code Repository</CardTitle>
          <StatusBadge ok={isConfigured} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="repoProviderMode"
            checked={mode === "default"}
            onChange={() => {
              setMode("default");
              setSelected("");
              saveField("repoProviderInstanceId", "");
            }}
            className="accent-primary"
          />
          <span className="text-sm">System default</span>
          {defaultInst && (
            <span className="text-xs text-muted-foreground">
              ({defaultInst.name} — {defaultInst.type})
            </span>
          )}
          {!defaultInst && instances.length === 0 && (
            <span className="text-xs text-muted-foreground">(not configured)</span>
          )}
        </label>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="repoProviderMode"
            checked={mode === "specific"}
            onChange={() => setMode("specific")}
            className="accent-primary"
          />
          <span className="text-sm">Specific instance</span>
        </label>

        {mode === "specific" && (
          <div className="pl-5">
            {instances.length > 0 ? (
              <select
                className="w-full px-2 py-1 text-sm border rounded bg-background"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  saveField("repoProviderInstanceId", e.target.value);
                }}
              >
                <option value="">Select...</option>
                {instances.map((inst) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.name} ({inst.type})
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">
                No instances configured. <a href="/integrations" className="underline">Add one</a>.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Integrations Tab
// ---------------------------------------------------------------------------

function IntegrationsTab({ project }: { project: ProjectData }) {
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
      {/* Issue Trackers */}
      <TrackerSettings projectName={project.name} />

      {/* AI Provider */}
      <AIProviderPicker project={project} saveField={saveField} />

      {/* IM Provider */}
      <IMProviderPicker project={project} saveField={saveField} />

      {/* Repo Provider */}
      <RepoProviderPicker project={project} saveField={saveField} />
    </div>
  );
}
