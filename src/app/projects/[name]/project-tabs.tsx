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
  linearPreviewLabel: string;
  linearAssigneeId: string | null;
  linearAssigneeName: string | null;
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
  const [linearPreviewLabel, setLinearPreviewLabel] = useState(project.linearPreviewLabel || "");
  const [githubToken, setGithubToken] = useState(project.githubToken || "");
  const [saving, setSaving] = useState<string | null>(null);

  // Detection mode: "label" or "assignee"
  const [detectionMode, setDetectionMode] = useState<"label" | "assignee">(
    project.linearAssigneeId ? "assignee" : "label"
  );
  const [assigneeId, setAssigneeId] = useState(project.linearAssigneeId || "");
  const [assigneeName, setAssigneeName] = useState(project.linearAssigneeName || "");
  const [members, setMembers] = useState<Array<{ id: string; name: string; email: string; displayName: string }>>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

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

  async function fetchMembers() {
    if (members.length > 0) return;
    setLoadingMembers(true);
    try {
      const resp = await fetch(`/api/projects/${project.name}/linear/members`);
      if (!resp.ok) throw new Error("Failed to fetch members");
      const data = await resp.json();
      setMembers(data);
    } catch {
      toast.error("Failed to load team members");
    } finally {
      setLoadingMembers(false);
    }
  }

  async function saveDetectionMode(mode: "label" | "assignee") {
    setDetectionMode(mode);
    setSaving("detectionMode");
    try {
      if (mode === "label") {
        // Clear assignee, keep label
        const resp = await fetch(`/api/projects/${project.name}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linearAssigneeId: null, linearAssigneeName: null }),
        });
        if (!resp.ok) throw new Error("Save failed");
        setAssigneeId("");
        setAssigneeName("");
      }
      // For assignee mode, user picks from dropdown which triggers saveAssignee
      toast.success(mode === "label" ? "Using label detection" : "Select an assignee");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(null);
    }
  }

  async function saveAssignee(memberId: string, memberName: string) {
    setAssigneeId(memberId);
    setAssigneeName(memberName);
    setSaving("assignee");
    try {
      const resp = await fetch(`/api/projects/${project.name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          linearAssigneeId: memberId || null,
          linearAssigneeName: memberName || null,
        }),
      });
      if (!resp.ok) throw new Error("Save failed");
      toast.success(`Assignee: ${memberName}`);
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

          {/* Issue detection mode */}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Issue Detection</label>
            <div className="flex gap-1 mb-2">
              <button
                className={`px-3 py-1 text-xs rounded-l border ${
                  detectionMode === "label"
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background text-muted-foreground border-border hover:text-foreground"
                }`}
                onClick={() => saveDetectionMode("label")}
              >
                By Label
              </button>
              <button
                className={`px-3 py-1 text-xs rounded-r border border-l-0 ${
                  detectionMode === "assignee"
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background text-muted-foreground border-border hover:text-foreground"
                }`}
                onClick={() => {
                  saveDetectionMode("assignee");
                  fetchMembers();
                }}
              >
                By Assignee
              </button>
            </div>

            {detectionMode === "label" && (
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
            )}

            {detectionMode === "assignee" && (
              <div className="flex gap-2">
                <select
                  className="flex-1 px-2 py-1 text-sm border rounded bg-background"
                  value={assigneeId}
                  onChange={(e) => {
                    const member = members.find((m) => m.id === e.target.value);
                    if (member) {
                      saveAssignee(member.id, member.displayName || member.name);
                    }
                  }}
                  onFocus={() => fetchMembers()}
                >
                  <option value="">Select member...</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName || m.name} ({m.email})
                    </option>
                  ))}
                </select>
                {loadingMembers && <span className="text-xs text-muted-foreground self-center">Loading...</span>}
                {saving === "assignee" && <span className="text-xs text-muted-foreground self-center">Saving...</span>}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">Preview Label (auto-deploy remote preview)</label>
            <div className="flex gap-2">
              <input
                className="flex-1 px-2 py-1 text-sm border rounded bg-background"
                value={linearPreviewLabel}
                onChange={(e) => setLinearPreviewLabel(e.target.value)}
                placeholder="TestPreview"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={saving === "linearPreviewLabel"}
                onClick={() => saveField("linearPreviewLabel", linearPreviewLabel)}
              >
                {saving === "linearPreviewLabel" ? "..." : "Save"}
              </Button>
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
