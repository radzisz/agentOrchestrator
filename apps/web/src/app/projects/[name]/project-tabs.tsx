"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { BranchesPanel } from "./branches-panel";
import { LocalBranchesPanel } from "./local-branches-panel";
import { RuntimeConfig, type RuntimeConfigData } from "./runtime-config";
import { RemoteConfig, type ProjectRtenvConfig } from "./remote-config";
import { TrackerSettings } from "./tracker-settings";
import { CdmTab } from "./cdm-tab";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Plus, Pencil, Trash2, ArrowUp, ArrowDown } from "lucide-react";

type Tab = "cdm" | "agents" | "preview" | "integrations" | "rules";

interface AIRule {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  order: number;
  whenToUse: string;
}

interface ProjectData {
  name: string;
  repoPath: string | null;
  repoUrl: string | null;
  hasGit: boolean;
  trackerConfigured: boolean;
  trackerTeamKey: string | null;
  trackerLabel: string;
  trackerPreviewLabel: string;
  repoProviderInstanceId: string | null;
  rtenvConfig: ProjectRtenvConfig;
  runtimeConfig: RuntimeConfigData | null;
  runtimeModes: { local: boolean; remote: boolean };
  aiProviderInstanceId: string | null;
  imProviderInstanceId: string | null;
  imEnabled: boolean;
  gitWorkMode: string | null;
  aiRules: AIRule[] | null;
}

export function ProjectTabs({
  project,
  agents,
}: {
  project: ProjectData;
  agents: any[];
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const TABS: Tab[] = ["cdm", "agents", "preview", "rules", "integrations"];
  const paramTab = searchParams.get("tab") as Tab | null;
  const tab: Tab = paramTab && TABS.includes(paramTab) ? paramTab : "cdm";
  const agentsRefreshRef = useRef<(() => void) | null>(null);
  const [pendingAgentsRefresh, setPendingAgentsRefresh] = useState(false);

  // When switching to agents tab after task submission, wait for the panel to mount
  // and then trigger refresh. router.push is async so searchParams don't update immediately.
  useEffect(() => {
    if (pendingAgentsRefresh && tab === "agents") {
      setPendingAgentsRefresh(false);
      // Small delay so LocalBranchesPanel mounts and sets agentsRefreshRef
      const t = setTimeout(() => agentsRefreshRef.current?.(), 200);
      return () => clearTimeout(t);
    }
  }, [pendingAgentsRefresh, tab]);

  const setTab = useCallback((t: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (t === "cdm") {
      params.delete("tab");
    } else {
      params.set("tab", t);
    }
    const qs = params.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [searchParams, pathname, router]);

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
    <div className="h-full overflow-y-auto overflow-x-hidden">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        <div className="px-6 py-3 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{project.name}</h1>
              <Badge variant={project.repoUrl ? "default" : "secondary"} className="text-[10px] h-5">
                {project.repoUrl ? "remote" : "local"}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm">{project.repoPath || project.repoUrl}</p>
          </div>
        </div>

        {!project.hasGit && (
          <div className="mx-6 mt-2 flex items-center gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-600 dark:text-yellow-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>No git repository found at <code className="font-mono text-xs">{project.repoPath}</code> — agents cannot spawn. Run <code className="font-mono text-xs">git init</code> first.</span>
          </div>
        )}

        {/* Tabs */}
        <div className="px-6 flex gap-0">
          {TABS.map((t) => {
            const needsSetup = t === "integrations" && !project.repoUrl;
            const label = t === "cdm" ? "Tasks" : t === "agents" ? "Agents" : t === "preview" ? "Preview" : t === "rules" ? "AI Rules" : "Integrations";
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
                {label}
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
        {tab === "cdm" && (
          <CdmTab projectName={project.name} onTaskSubmitted={() => {
            setPendingAgentsRefresh(true);
            setTab("agents");
          }} />
        )}
        {tab === "agents" && (
          <LocalBranchesPanel
            onRefreshRef={agentsRefreshRef}
            projectName={project.name}
            linearConfigured={project.trackerConfigured}
            linearTeamKey={project.trackerTeamKey}
            linearLabel={project.trackerLabel}
            githubConfigured={false}
          />
        )}
        {tab === "preview" && (
          <PreviewTab
            project={project}
            modes={modes}
            onToggleLocal={() => toggleMode("local")}
            onToggleRemote={() => toggleMode("remote")}
          />
        )}
        {tab === "rules" && (
          <ProjectAIRules projectName={project.name} initialRules={project.aiRules || []} />
        )}
        {tab === "integrations" && (
          <IntegrationsTab project={project} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview Tab (merged Local + Remote)
// ---------------------------------------------------------------------------

function PreviewTab({
  project,
  modes,
  onToggleLocal,
  onToggleRemote,
}: {
  project: ProjectData;
  modes: { local: boolean; remote: boolean };
  onToggleLocal: () => void;
  onToggleRemote: () => void;
}) {
  return (
    <div className="space-y-6">
      <RuntimeConfig
        projectName={project.name}
        initialConfig={project.runtimeConfig}
        enabled={modes.local}
        onToggle={onToggleLocal}
      />

      <RemoteConfig
        projectName={project.name}
        initialRtenvConfig={project.rtenvConfig}
        enabled={modes.remote}
        onToggle={onToggleRemote}
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
  enabled: boolean;
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
  const [enabled, setEnabled] = useState(project.imEnabled);

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
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 cursor-pointer" title={enabled ? "IM notifications enabled" : "IM notifications disabled"}>
              <span className="text-xs text-muted-foreground">{enabled ? "On" : "Off"}</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${enabled ? "bg-primary" : "bg-muted"}`}
                onClick={() => {
                  const next = !enabled;
                  setEnabled(next);
                  saveField("imEnabled", next ? "true" : "false");
                }}
              >
                <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${enabled ? "translate-x-4" : "translate-x-0"}`} />
              </button>
            </label>
            <StatusBadge ok={isConfigured} />
          </div>
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
          {defaultInst && !defaultInst.enabled && (
            <span className="text-[10px] bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded font-medium">off</span>
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
              <>
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
                      {inst.name} ({inst.type}){inst.config.chatId ? ` — ${inst.config.chatId}` : ""}{!inst.enabled ? " [OFF]" : ""}
                    </option>
                  ))}
                </select>
                {selected && instances.find((i) => i.id === selected && !i.enabled) && (
                  <div className="mt-1">
                    <span className="text-[10px] bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded font-medium">off</span>
                    <span className="text-[10px] text-muted-foreground ml-1">instancja wyłączona globalnie</span>
                  </div>
                )}
              </>
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
// Git Work Mode Picker
// ---------------------------------------------------------------------------

function GitWorkModePicker({
  project,
  saveField,
}: {
  project: ProjectData;
  saveField: (field: string, value: string) => Promise<void>;
}) {
  const [mode, setMode] = useState(project.gitWorkMode || "default");

  function handleChange(value: string) {
    setMode(value);
    saveField("gitWorkMode", value === "default" ? "" : value);
  }

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Git Working Mode</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="gitWorkMode"
            checked={mode === "default"}
            onChange={() => handleChange("default")}
            className="accent-primary mt-1"
          />
          <div>
            <span className="text-sm">Default</span>
            <p className="text-xs text-muted-foreground">
              Always clone the repo — agent has full remote access to push and rebase.
            </p>
          </div>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="gitWorkMode"
            checked={mode === "branch"}
            onChange={() => handleChange("branch")}
            className="accent-primary mt-1"
          />
          <div>
            <span className="text-sm">Branch</span>
            <p className="text-xs text-muted-foreground">
              Always clone the repo into a separate directory and work on a new branch.
            </p>
          </div>
        </label>

      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Project AI Rules
// ---------------------------------------------------------------------------

function ProjectAIRules({ projectName, initialRules }: { projectName: string; initialRules: AIRule[] }) {
  const [rules, setRules] = useState<AIRule[]>(initialRules);
  const saveCounter = useRef(0);

  function updateRules(updater: (prev: AIRule[]) => AIRule[]) {
    setRules((prev) => {
      const next = updater(prev);
      saveCounter.current++;
      const snap = saveCounter.current;
      setTimeout(() => {
        if (snap !== saveCounter.current) return; // debounce
        fetch(`/api/projects/${projectName}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aiRules: next }),
        }).then((r) => {
          if (r.ok) toast.success("Rules saved");
          else toast.error("Failed to save rules");
        }).catch(() => toast.error("Failed to save rules"));
      }, 500);
      return next;
    });
  }
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);
  const [formWhenToUse, setFormWhenToUse] = useState("");

  function resetForm() {
    setShowForm(false);
    setEditingId(null);
    setFormTitle("");
    setFormContent("");
    setFormEnabled(true);
    setFormWhenToUse("");
  }

  function handleSaveRule() {
    if (!formTitle.trim()) return;
    const nextOrder = rules.length > 0 ? Math.max(...rules.map((r) => r.order)) + 1 : 0;

    if (editingId) {
      updateRules((prev) => prev.map((r) =>
        r.id === editingId ? { ...r, title: formTitle, content: formContent, enabled: formEnabled, whenToUse: formWhenToUse } : r
      ));
    } else {
      updateRules((prev) => [...prev, {
        id: crypto.randomUUID(),
        title: formTitle,
        content: formContent,
        enabled: formEnabled,
        order: nextOrder,
        whenToUse: formWhenToUse,
      }]);
    }
    resetForm();
  }

  function handleStartEdit(rule: AIRule) {
    setEditingId(rule.id);
    setFormTitle(rule.title);
    setFormContent(rule.content);
    setFormEnabled(rule.enabled);
    setFormWhenToUse(rule.whenToUse);
    setShowForm(true);
  }

  const sorted = [...rules].sort((a, b) => a.order - b.order);

  function handleMove(id: string, dir: -1 | 1) {
    const s = [...rules].sort((a, b) => a.order - b.order);
    const idx = s.findIndex((r) => r.id === id);
    const target = idx + dir;
    if (target < 0 || target >= s.length) return;
    const tmpOrder = s[idx].order;
    s[idx] = { ...s[idx], order: s[target].order };
    s[target] = { ...s[target], order: tmpOrder };
    updateRules(() => s);
  }

  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">AI Rules</CardTitle>
        </div>
        <p className="text-xs text-muted-foreground">Project rules — applied alongside global rules. Agent decides which to apply.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {sorted.map((rule, idx) => (
          <div key={rule.id} className="flex items-start gap-2 p-3 border rounded-lg bg-muted/30">
            <div className="flex flex-col gap-0.5 mt-1">
              <button className="text-muted-foreground hover:text-foreground disabled:opacity-20 p-0" disabled={idx === 0} onClick={() => handleMove(rule.id, -1)}>
                <ArrowUp className="h-3 w-3" />
              </button>
              <button className="text-muted-foreground hover:text-foreground disabled:opacity-20 p-0" disabled={idx === sorted.length - 1} onClick={() => handleMove(rule.id, 1)}>
                <ArrowDown className="h-3 w-3" />
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-medium ${rule.enabled ? "" : "text-muted-foreground line-through"}`}>{rule.title}</span>
              </div>
              {rule.whenToUse && <p className="text-xs text-blue-500 mt-0.5">{rule.whenToUse}</p>}
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{rule.content}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                role="switch"
                aria-checked={rule.enabled}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${rule.enabled ? "bg-primary" : "bg-muted"}`}
                onClick={() => updateRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))}
              >
                <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${rule.enabled ? "translate-x-4" : "translate-x-0"}`} />
              </button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleStartEdit(rule)}><Pencil className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => updateRules((prev) => prev.filter((r) => r.id !== rule.id))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        ))}

        {showForm ? (
          <div className="border rounded-lg p-4 space-y-3 bg-muted/20">
            <input className="w-full px-3 py-1.5 text-sm border rounded bg-background" placeholder="Rule title" value={formTitle} onChange={(e) => setFormTitle(e.target.value)} />
            <input className="w-full px-3 py-1.5 text-sm border rounded bg-background" placeholder="When to use (e.g. 'When task involves React frontend')" value={formWhenToUse} onChange={(e) => setFormWhenToUse(e.target.value)} />
            <textarea className="w-full px-3 py-1.5 text-sm border rounded bg-background min-h-[80px] font-mono" placeholder="Rule content (Markdown)" value={formContent} onChange={(e) => setFormContent(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSaveRule} disabled={!formTitle.trim()}>{editingId ? "Update" : "Add"}</Button>
              <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Rule
          </Button>
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

      {/* Git Work Mode */}
      <GitWorkModePicker project={project} saveField={saveField} />
    </div>
  );
}
