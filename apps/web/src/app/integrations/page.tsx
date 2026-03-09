"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IntegrationConfigEditor } from "./integration-config";
import { IntegrationLogs } from "./integration-logs";
import { ChevronDown, ChevronRight, ChevronUp, Star, Trash2, Plus, GripVertical, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ConfigField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "secret" | "select";
  required?: boolean;
  description?: string;
  default?: string;
  options?: Array<{ label: string; value: string }>;
}

interface IntegrationData {
  name: string;
  displayName: string;
  enabled: boolean;
  active: boolean;
  builtIn: boolean;
  configSchema: ConfigField[];
  configs: Array<{ key: string; value: string }>;
}

interface TrackerInstanceData {
  id: string;
  type: string;
  name: string;
  isDefault: boolean;
  config: Record<string, string>;
}

interface TrackerSchemaField {
  key: string;
  label: string;
  type: "string" | "secret" | "select";
  required?: boolean;
  description?: string;
  default?: string;
  options?: Array<{ label: string; value: string }>;
  projectOverride?: boolean;
  visibleWhen?: { field: string; value: string };
}

interface TrackerSchema {
  type: string;
  displayName: string;
  fields: TrackerSchemaField[];
}

// ---------------------------------------------------------------------------
// AI Providers Section
// ---------------------------------------------------------------------------

interface AIProviderInstanceData {
  id: string;
  type: "claude-code" | "aider";
  name: string;
  isDefault: boolean;
  config: Record<string, string>;
}

function defaultName(type: string, backend: string): string {
  if (type === "claude-code") return "Claude Code";
  const backendNames: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", ollama: "Ollama" };
  return `Aider + ${backendNames[backend] || backend}`;
}

function AIProvidersSection() {
  const [instances, setInstances] = useState<AIProviderInstanceData[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("Claude Code");
  const [formType, setFormType] = useState<"claude-code" | "aider">("claude-code");
  const [formModel, setFormModel] = useState("");
  const [formBackend, setFormBackend] = useState("anthropic");
  const [formApiKey, setFormApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const resp = await fetch("/api/ai-providers");
      const data = await resp.json();
      setInstances(data.instances || []);
    } catch {}
  }

  useEffect(() => { load(); }, []);

  async function handleAdd() {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      const config: Record<string, string> = {};
      if (formModel) config.model = formModel;
      if (formType === "aider") {
        config.aiderBackend = formBackend;
        if (formBackend === "openai" && formApiKey) {
          config.OPENAI_API_KEY = formApiKey;
        }
      }
      const resp = await fetch("/api/ai-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: formType, name: formName, config }),
      });
      if (!resp.ok) throw new Error("Failed");
      toast.success("AI provider added");
      setShowForm(false);
      setFormName("Claude Code");
      setFormType("claude-code");
      setFormBackend("anthropic");
      setFormModel("");
      setFormApiKey("");
      await load();
    } catch {
      toast.error("Failed to add AI provider");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await fetch("/api/ai-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, isDefault: true }),
      });
      toast.success("Default updated");
      await load();
    } catch {
      toast.error("Failed");
    }
  }

  async function handleDelete(id: string) {
    try {
      await fetch("/api/ai-providers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      toast.success("Deleted");
      await load();
    } catch {
      toast.error("Failed");
    }
  }

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <CardTitle>AI Providers</CardTitle>

            {!isOpen && instances.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Default: {instances.find((i) => i.isDefault)?.name ?? instances[0]?.name}
              </span>
            )}
          </div>
          {instances.length > 0 ? (
            <Badge className="bg-green-600 text-white border-0 text-xs px-2.5">{instances.length} configured</Badge>
          ) : (
            <Badge variant="outline" className="text-xs border-red-600 text-red-400 px-2.5">
              Not configured
            </Badge>
          )}
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="space-y-3 pt-0">
          {instances.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No AI provider instances configured. Using hardcoded default (Claude Code / sonnet).
            </p>
          )}

          {instances.map((inst) => (
            <div key={inst.id} className="flex items-center justify-between border rounded px-3 py-2">
              <div className="flex items-center gap-2">
                <button onClick={() => handleSetDefault(inst.id)}
                  className={`p-0.5 rounded ${inst.isDefault ? "text-yellow-400" : "text-muted-foreground hover:text-yellow-400"}`}
                  title={inst.isDefault ? "Default" : "Set as default"}>
                  <Star className={`h-3.5 w-3.5 ${inst.isDefault ? "fill-current" : ""}`} />
                </button>
                <span className="text-sm font-medium">{inst.name}</span>
                <Badge variant="outline" className="text-[10px]">{inst.type}</Badge>
                {inst.config.model && <span className="text-xs text-muted-foreground font-mono">{inst.config.model}</span>}
                {inst.config.aiderBackend && <span className="text-xs text-muted-foreground">({inst.config.aiderBackend})</span>}
              </div>
              <button onClick={() => handleDelete(inst.id)} className="text-muted-foreground hover:text-destructive p-1">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}

          {showForm ? (
            <div className="border rounded p-3 space-y-2">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Provider</label>
                <select className="w-full px-2 py-1 text-sm border rounded bg-background"
                  value={formType === "aider" ? `aider-${formBackend}` : "claude-code"}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "claude-code") {
                      setFormType("claude-code"); setFormBackend("anthropic");
                      setFormName((prev) => !prev || prev === defaultName(formType, formBackend) ? "Claude Code" : prev);
                    } else {
                      const backend = v.replace("aider-", "");
                      setFormType("aider"); setFormBackend(backend);
                      setFormName((prev) => !prev || prev === defaultName(formType, formBackend) ? defaultName("aider", backend) : prev);
                    }
                  }}>
                  <option value="claude-code">Claude Code</option>
                  <option value="aider-anthropic">Aider + Anthropic</option>
                  <option value="aider-openai">Aider + OpenAI</option>
                  <option value="aider-ollama">Aider + Ollama (local)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Agent name</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background" autoComplete="off"
                  value={formName} onChange={(e) => setFormName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Model</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background" list="ai-provider-models"
                  placeholder={formType === "claude-code" ? "sonnet" : formBackend === "openai" ? "gpt-4o" : formBackend === "ollama" ? "llama3" : "sonnet"}
                  value={formModel} onChange={(e) => setFormModel(e.target.value)} />
                <datalist id="ai-provider-models">
                  {formType === "claude-code" && <><option value="sonnet" /><option value="opus" /><option value="haiku" /></>}
                  {formType === "aider" && formBackend === "anthropic" && <><option value="sonnet" /><option value="opus" /><option value="haiku" /><option value="claude-sonnet-4-20250514" /><option value="claude-opus-4-20250514" /></>}
                  {formType === "aider" && formBackend === "openai" && <><option value="gpt-4o" /><option value="gpt-4o-mini" /><option value="gpt-4.1" /><option value="gpt-4.1-mini" /><option value="o3" /><option value="o4-mini" /></>}
                  {formType === "aider" && formBackend === "ollama" && <><option value="llama3" /><option value="llama3.1" /><option value="codellama" /><option value="deepseek-coder-v2" /><option value="mistral" /></>}
                </datalist>
              </div>
              {formType === "aider" && formBackend === "openai" && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">OpenAI API Key</label>
                  <input className="w-full px-2 py-1 text-sm border rounded bg-background font-mono" type="password"
                    placeholder="sk-..." value={formApiKey} onChange={(e) => setFormApiKey(e.target.value)} />
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAdd} disabled={saving || !formName.trim()}>{saving ? "..." : "Add"}</Button>
                <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="w-full"
              onClick={(e) => { e.stopPropagation(); setShowForm(true); }}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add AI Provider
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Instant Messaging Section
// ---------------------------------------------------------------------------

interface IMProviderInstanceData {
  id: string;
  type: "telegram";
  name: string;
  isDefault: boolean;
  enabled: boolean;
  config: Record<string, string>;
}

function IMProvidersSection() {
  const [instances, setInstances] = useState<IMProviderInstanceData[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("Telegram Bot");
  const [formType] = useState<"telegram">("telegram");
  const [formBotToken, setFormBotToken] = useState("");
  const [formChatId, setFormChatId] = useState("");
  const [saving, setSaving] = useState(false);

  async function toggleInstanceEnabled(inst: IMProviderInstanceData) {
    const next = !inst.enabled;
    setInstances((prev) => prev.map((i) => i.id === inst.id ? { ...i, enabled: next } : i));
    try {
      await fetch("/api/im-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: inst.id, enabled: next }),
      });
      toast.success(next ? `${inst.name} enabled` : `${inst.name} disabled`);
    } catch {
      setInstances((prev) => prev.map((i) => i.id === inst.id ? { ...i, enabled: !next } : i));
      toast.error("Failed to toggle");
    }
  }

  async function load() {
    try {
      const resp = await fetch("/api/im-providers");
      const data = await resp.json();
      setInstances(data.instances || []);
    } catch {}
  }

  useEffect(() => { load(); }, []);

  async function handleAdd() {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      const config: Record<string, string> = {};
      if (formBotToken) config.botToken = formBotToken;
      if (formChatId) config.chatId = formChatId;
      const resp = await fetch("/api/im-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: formType, name: formName, config }),
      });
      if (!resp.ok) throw new Error("Failed");
      toast.success("IM provider added");
      resetForm();
      await load();
    } catch {
      toast.error("Failed to add IM provider");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await fetch("/api/im-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, isDefault: true }),
      });
      toast.success("Default updated");
      await load();
    } catch {
      toast.error("Failed");
    }
  }

  function handleStartEdit(inst: IMProviderInstanceData) {
    setEditingId(inst.id);
    setFormName(inst.name);
    setFormBotToken(inst.config.botToken || "");
    setFormChatId(inst.config.chatId || "");
    setShowForm(true);
  }

  async function handleSaveEdit() {
    if (!editingId || !formName.trim()) return;
    setSaving(true);
    try {
      const config: Record<string, string> = {};
      if (formBotToken) config.botToken = formBotToken;
      if (formChatId) config.chatId = formChatId;
      const resp = await fetch("/api/im-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, name: formName, config }),
      });
      if (!resp.ok) throw new Error("Failed");
      toast.success("IM provider updated");
      resetForm();
      await load();
    } catch {
      toast.error("Failed to update IM provider");
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setShowForm(false);
    setEditingId(null);
    setFormName("Telegram Bot");
    setFormBotToken("");
    setFormChatId("");
  }

  async function handleDelete(id: string) {
    try {
      await fetch("/api/im-providers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      toast.success("Deleted");
      await load();
    } catch {
      toast.error("Failed");
    }
  }

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <CardTitle>Instant Messaging</CardTitle>

            {!isOpen && instances.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Default: {instances.find((i) => i.isDefault)?.name ?? instances[0]?.name}
              </span>
            )}
          </div>
          {instances.length > 0 ? (
            <Badge className="bg-green-600 text-white border-0 text-xs px-2.5">{instances.length} configured</Badge>
          ) : (
            <Badge variant="outline" className="text-xs border-red-600 text-red-400 px-2.5">
              Not configured
            </Badge>
          )}
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="space-y-3 pt-0">
          {instances.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No IM provider instances configured. Add one to enable Telegram notifications.
            </p>
          )}

          {instances.map((inst) => (
            <div key={inst.id} className={`flex items-center justify-between border rounded px-3 py-2 ${!inst.enabled ? "opacity-50" : ""}`}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={inst.enabled}
                  title={inst.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
                  className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${inst.enabled ? "bg-primary" : "bg-muted"}`}
                  onClick={() => toggleInstanceEnabled(inst)}
                >
                  <span className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow ring-0 transition-transform ${inst.enabled ? "translate-x-3" : "translate-x-0"}`} />
                </button>
                <button onClick={() => handleSetDefault(inst.id)}
                  className={`p-0.5 rounded ${inst.isDefault ? "text-yellow-400" : "text-muted-foreground hover:text-yellow-400"}`}
                  title={inst.isDefault ? "Default" : "Set as default"}>
                  <Star className={`h-3.5 w-3.5 ${inst.isDefault ? "fill-current" : ""}`} />
                </button>
                <span className="text-sm font-medium">{inst.name}</span>
                <Badge variant="outline" className="text-[10px]">{inst.type}</Badge>
                {inst.config.chatId && <span className="text-xs text-muted-foreground font-mono">chatId={inst.config.chatId}</span>}
                {inst.config.botToken && (
                  <Badge variant="outline" className="text-[10px] border-green-600 text-green-400">Bot Token set</Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => handleStartEdit(inst)} className="text-muted-foreground hover:text-foreground p-1" title="Edit">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => handleDelete(inst.id)} className="text-muted-foreground hover:text-destructive p-1" title="Delete">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}

          {instances.length > 0 && <IntegrationLogs name="telegram" />}

          {showForm ? (
            <div className="border rounded p-3 space-y-2">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Type</label>
                <select className="w-full px-2 py-1 text-sm border rounded bg-background" value={formType} disabled>
                  <option value="telegram">Telegram</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Name</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background" autoComplete="off"
                  value={formName} onChange={(e) => setFormName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Bot Token</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background font-mono" type="password"
                  placeholder="123456:ABC-DEF..." value={formBotToken} onChange={(e) => setFormBotToken(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Chat ID</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background font-mono"
                  placeholder="-100..." value={formChatId} onChange={(e) => setFormChatId(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={editingId ? handleSaveEdit : handleAdd} disabled={saving || !formName.trim()}>
                  {saving ? "..." : editingId ? "Save" : "Add"}
                </Button>
                <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="w-full"
              onClick={(e) => { e.stopPropagation(); setEditingId(null); setShowForm(true); }}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add IM Provider
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Source Code Repositories Section
// ---------------------------------------------------------------------------

interface RepoProviderInstanceData {
  id: string;
  type: "github" | "gitlab";
  name: string;
  isDefault: boolean;
  config: Record<string, string>;
}

function RepoProvidersSection() {
  const [instances, setInstances] = useState<RepoProviderInstanceData[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("GitHub");
  const [formType, setFormType] = useState<"github" | "gitlab">("github");
  const [formAuthMode, setFormAuthMode] = useState<"os" | "token">("os");
  const [formToken, setFormToken] = useState("");
  const [formCommitterName, setFormCommitterName] = useState("");
  const [formCommitterEmail, setFormCommitterEmail] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const resp = await fetch("/api/repo-providers");
      const data = await resp.json();
      setInstances(data.instances || []);
    } catch {}
  }

  useEffect(() => { load(); }, []);

  async function handleAdd() {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      const config: Record<string, string> = { authMode: formAuthMode };
      if (formAuthMode === "token" && formToken) config.token = formToken;
      if (formCommitterName) config.committerName = formCommitterName;
      if (formCommitterEmail) config.committerEmail = formCommitterEmail;
      const resp = await fetch("/api/repo-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: formType, name: formName, config }),
      });
      if (!resp.ok) throw new Error("Failed");
      toast.success("Repo provider added");
      setShowForm(false);
      setFormName("GitHub");
      setFormType("github");
      setFormAuthMode("os");
      setFormToken("");
      setFormCommitterName("");
      setFormCommitterEmail("");
      await load();
    } catch {
      toast.error("Failed to add repo provider");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await fetch("/api/repo-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, isDefault: true }),
      });
      toast.success("Default updated");
      await load();
    } catch {
      toast.error("Failed");
    }
  }

  async function handleDelete(id: string) {
    try {
      await fetch("/api/repo-providers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      toast.success("Deleted");
      await load();
    } catch {
      toast.error("Failed");
    }
  }

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <CardTitle>Source Code Repositories</CardTitle>

            {!isOpen && instances.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Default: {instances.find((i) => i.isDefault)?.name ?? instances[0]?.name}
              </span>
            )}
          </div>
          {instances.length > 0 ? (
            <Badge className="bg-green-600 text-white border-0 text-xs px-2.5">{instances.length} configured</Badge>
          ) : (
            <Badge variant="outline" className="text-xs border-red-600 text-red-400 px-2.5">
              Not configured
            </Badge>
          )}
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="space-y-3 pt-0">
          {instances.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No repo provider instances configured. Add one to enable Git integration (push, PR creation, etc.).
            </p>
          )}

          {instances.map((inst) => (
            <div key={inst.id} className="flex items-center justify-between border rounded px-3 py-2">
              <div className="flex items-center gap-2">
                <button onClick={() => handleSetDefault(inst.id)}
                  className={`p-0.5 rounded ${inst.isDefault ? "text-yellow-400" : "text-muted-foreground hover:text-yellow-400"}`}
                  title={inst.isDefault ? "Default" : "Set as default"}>
                  <Star className={`h-3.5 w-3.5 ${inst.isDefault ? "fill-current" : ""}`} />
                </button>
                <span className="text-sm font-medium">{inst.name}</span>
                <Badge variant="outline" className="text-[10px]">{inst.type}</Badge>
                <span className="text-xs text-muted-foreground">
                  {inst.config.authMode === "token" ? "token" : "OS auth"}
                </span>
                {inst.config.token && (
                  <Badge variant="outline" className="text-[10px] border-green-600 text-green-400">Token set</Badge>
                )}
                {(inst.config.committerName || inst.config.committerEmail) && (
                  <span className="text-xs text-muted-foreground font-mono">
                    {inst.config.committerName}{inst.config.committerEmail ? ` <${inst.config.committerEmail}>` : ""}
                  </span>
                )}
              </div>
              <button onClick={() => handleDelete(inst.id)} className="text-muted-foreground hover:text-destructive p-1">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}

          {showForm ? (
            <div className="border rounded p-3 space-y-2">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Type</label>
                <select className="w-full px-2 py-1 text-sm border rounded bg-background"
                  value={formType}
                  onChange={(e) => {
                    const t = e.target.value as "github" | "gitlab";
                    setFormType(t);
                    setFormName(t === "github" ? "GitHub" : "GitLab");
                  }}>
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Name</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background" autoComplete="off"
                  value={formName} onChange={(e) => setFormName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Auth Mode</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="repoAuthMode" checked={formAuthMode === "os"}
                      onChange={() => setFormAuthMode("os")} className="accent-primary" />
                    <span className="text-sm">Handled by OS</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="repoAuthMode" checked={formAuthMode === "token"}
                      onChange={() => setFormAuthMode("token")} className="accent-primary" />
                    <span className="text-sm">Token</span>
                  </label>
                </div>
              </div>
              {formAuthMode === "token" && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Token</label>
                  <input className="w-full px-2 py-1 text-sm border rounded bg-background font-mono" type="password"
                    placeholder="ghp_... / glpat-..." value={formToken} onChange={(e) => setFormToken(e.target.value)} />
                </div>
              )}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Committer Name</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background"
                  placeholder="Bot Name" value={formCommitterName} onChange={(e) => setFormCommitterName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Committer Email</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background"
                  placeholder="bot@example.com" value={formCommitterEmail} onChange={(e) => setFormCommitterEmail(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAdd} disabled={saving || !formName.trim()}>{saving ? "..." : "Add"}</Button>
                <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="w-full"
              onClick={(e) => { e.stopPropagation(); setShowForm(true); }}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Repo Provider
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Issue Trackers Section — unified card (like AI Providers)
// ---------------------------------------------------------------------------

function IssueTrackersSection() {
  const [instances, setInstances] = useState<TrackerInstanceData[]>([]);
  const [schemas, setSchemas] = useState<TrackerSchema[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState("");
  const [formName, setFormName] = useState("");
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editConfig, setEditConfig] = useState<Record<string, string>>({});

  async function load() {
    try {
      const resp = await fetch("/api/tracker-instances");
      if (resp.ok) {
        const data = await resp.json();
        setInstances(data.instances || []);
        setSchemas(data.schemas || []);
        if (!formType && data.schemas?.length > 0) setFormType(data.schemas[0].type);
      }
    } catch {}
  }

  useEffect(() => { load(); }, []);

  const currentSchema = schemas.find((s) => s.type === formType);
  const instanceFields = currentSchema?.fields.filter((f) => !f.projectOverride) || [];

  function isFieldVisible(field: TrackerSchemaField, config: Record<string, string>) {
    if (!field.visibleWhen) return true;
    return (config[field.visibleWhen.field] || "") === field.visibleWhen.value;
  }

  function fieldsForType(type: string) {
    return schemas.find((s) => s.type === type)?.fields.filter((f) => !f.projectOverride) || [];
  }

  function resetForm() {
    setFormName("");
    const defaults: Record<string, string> = {};
    for (const f of instanceFields) { if (f.default) defaults[f.key] = f.default; }
    setFormConfig(defaults);
    setShowForm(false);
  }

  async function handleAdd() {
    if (!formName.trim() || !formType) return;
    setSaving(true);
    try {
      const resp = await fetch("/api/tracker-instances", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: formType, name: formName.trim(), config: formConfig }),
      });
      if (!resp.ok) throw new Error("Failed");
      toast.success("Instance added");
      resetForm();
      await load();
    } catch { toast.error("Failed to add instance"); }
    finally { setSaving(false); }
  }

  async function handleSetDefault(id: string) {
    try {
      await fetch("/api/tracker-instances", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, isDefault: true }) });
      toast.success("Default updated"); await load();
    } catch { toast.error("Failed"); }
  }

  async function handleDelete(id: string) {
    try {
      await fetch("/api/tracker-instances", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      toast.success("Deleted"); await load();
    } catch { toast.error("Failed"); }
  }

  async function handleSaveEdit(id: string) {
    setSaving(true);
    try {
      await fetch("/api/tracker-instances", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, config: editConfig }) });
      toast.success("Instance updated"); setEditingId(null); await load();
    } catch { toast.error("Failed to update"); }
    finally { setSaving(false); }
  }

  function renderField(field: TrackerSchemaField, value: string, onChange: (v: string) => void) {
    if (field.type === "select" && field.options) {
      return (
        <select className="w-full px-2 py-1 text-sm border rounded bg-background" value={value || field.default || ""} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
      );
    }
    return (
      <input className="w-full px-2 py-1 text-sm border rounded bg-background font-mono"
        type={field.type === "secret" ? "password" : "text"} value={value || ""}
        onChange={(e) => onChange(e.target.value)} placeholder={field.description || ""} />
    );
  }

  return (
    <Card>
      <CardHeader className="cursor-pointer select-none" onClick={() => setIsOpen(!isOpen)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <CardTitle>Issue Trackers</CardTitle>
            {!isOpen && instances.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {instances.length} instance{instances.length !== 1 ? "s" : ""}
                {" — "}{[...new Set(instances.map((i) => i.type))].map((t) => schemas.find((s) => s.type === t)?.displayName || t).join(", ")}
              </span>
            )}
          </div>
          {instances.length > 0
            ? <Badge className="bg-green-600 text-white border-0 text-xs px-2.5">Active</Badge>
            : <Badge variant="outline" className="text-xs border-red-600 text-red-400 px-2.5">Not configured</Badge>}
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="space-y-3 pt-0">
          {instances.length === 0 && (
            <p className="text-xs text-muted-foreground">No tracker instances configured. Add one to connect Linear, Sentry, etc.</p>
          )}

          {schemas.map((schema) => {
            const typeInst = instances.filter((i) => i.type === schema.type);
            if (typeInst.length === 0) return null;
            const fields = fieldsForType(schema.type);
            return (
              <div key={schema.type}>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">{schema.displayName}</p>
                {typeInst.map((inst) => (
                  <div key={inst.id} className="mb-2">
                    <div className="flex items-center justify-between border rounded px-3 py-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{inst.name}</span>
                        {fields.filter((f) => f.type !== "secret" && inst.config[f.key]).map((f) => (
                          <span key={f.key} className="text-xs text-muted-foreground font-mono">{f.key}={inst.config[f.key]}</span>
                        ))}
                        {fields.filter((f) => f.type === "secret" && inst.config[f.key]).map((f) => (
                          <Badge key={f.key} variant="outline" className="text-[10px] border-green-600 text-green-400">{f.label} set</Badge>
                        ))}
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { editingId === inst.id ? setEditingId(null) : (setEditingId(inst.id), setEditConfig({ ...inst.config })); }}
                          className="text-muted-foreground hover:text-foreground p-1 text-xs">Edit</button>
                        <button onClick={() => handleDelete(inst.id)} className="text-muted-foreground hover:text-destructive p-1">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    {editingId === inst.id && (
                      <div className="border border-t-0 rounded-b p-3 space-y-2 bg-muted/20">
                        {fields.map((field) => {
                          if (!isFieldVisible(field, editConfig)) return null;
                          return (
                            <div key={field.key}>
                              <label className="text-xs text-muted-foreground block mb-1">{field.label}{field.required && <span className="text-destructive ml-0.5">*</span>}</label>
                              {renderField(field, editConfig[field.key] || "", (v) => setEditConfig({ ...editConfig, [field.key]: v }))}
                            </div>
                          );
                        })}
                        {(editConfig.mode === "webhook") && (
                          <p className="text-xs text-muted-foreground italic py-2">Not yet implemented (security issues)</p>
                        )}
                        <div className="flex gap-2 pt-1">
                          <Button size="sm" onClick={() => handleSaveEdit(inst.id)} disabled={saving}>{saving ? "..." : "Save"}</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <IntegrationLogs name={schema.type} />
              </div>
            );
          })}

          {showForm ? (
            <div className="border rounded p-3 space-y-2">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Tracker Type</label>
                <select className="w-full px-2 py-1 text-sm border rounded bg-background" value={formType}
                  onChange={(e) => {
                    setFormType(e.target.value);
                    const s = schemas.find((sc) => sc.type === e.target.value);
                    const defaults: Record<string, string> = {};
                    for (const f of s?.fields.filter((f) => !f.projectOverride) || []) { if (f.default) defaults[f.key] = f.default; }
                    setFormConfig(defaults);
                    // Auto-generate name based on type + existing count
                    const typeCount = instances.filter((i) => i.type === e.target.value).length;
                    setFormName((s?.displayName || "") + (typeCount > 0 ? ` ${typeCount + 1}` : ""));
                  }}>
                  {schemas.map((s) => <option key={s.type} value={s.type}>{s.displayName}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Instance Name</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background" placeholder='e.g. "Team UKR"'
                  value={formName} onChange={(e) => setFormName(e.target.value)} />
              </div>
              {instanceFields.map((field) => {
                if (!isFieldVisible(field, formConfig)) return null;
                return (
                  <div key={field.key}>
                    <label className="text-xs text-muted-foreground block mb-1">{field.label}{field.required && <span className="text-destructive ml-0.5">*</span>}</label>
                    {renderField(field, formConfig[field.key] || "", (v) => setFormConfig({ ...formConfig, [field.key]: v }))}
                  </div>
                );
              })}
              {(formConfig.mode === "webhook") && (
                <p className="text-xs text-muted-foreground italic py-2">Not yet implemented (security issues)</p>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAdd} disabled={saving || !formName.trim() || formConfig.mode === "webhook"}>{saving ? "..." : "Add"}</Button>
                <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="w-full" onClick={(e) => {
              e.stopPropagation();
              setShowForm(true);
              // Auto-generate name from current formType
              const s = schemas.find((sc) => sc.type === formType);
              const typeCount = instances.filter((i) => i.type === formType).length;
              setFormName((s?.displayName || formType) + (typeCount > 0 ? ` ${typeCount + 1}` : ""));
              // Initialize defaults so visibleWhen works immediately
              const defaults: Record<string, string> = {};
              for (const f of s?.fields.filter((f) => !f.projectOverride) || []) { if (f.default) defaults[f.key] = f.default; }
              setFormConfig(defaults);
            }}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Instance
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Integrations Page
// ---------------------------------------------------------------------------
// Runtime Environments Section (Supabase / Netlify / Vercel)
// ---------------------------------------------------------------------------

interface RtenvInstanceData {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
}

interface RtenvSchemaData {
  type: string;
  displayName: string;
  fields: Array<{ key: string; label: string; type: string; required?: boolean; description?: string }>;
  projectFields: Array<{ key: string; label: string; type: string; required?: boolean; description?: string }>;
}

function RuntimeEnvsSection() {
  const [instances, setInstances] = useState<RtenvInstanceData[]>([]);
  const [schemas, setSchemas] = useState<RtenvSchemaData[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState("supabase");
  const [formName, setFormName] = useState("Supabase");
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const resp = await fetch("/api/rtenv-providers");
      const data = await resp.json();
      setInstances(data.instances || []);
      setSchemas(data.schemas || []);
    } catch {}
  }

  useEffect(() => { load(); }, []);

  const currentSchema = schemas.find((s) => s.type === formType);

  function resetForm() {
    setShowForm(false);
    setEditingId(null);
    setFormType("supabase");
    setFormName("Supabase");
    setFormConfig({});
  }

  function handleStartEdit(inst: RtenvInstanceData) {
    setEditingId(inst.id);
    setFormType(inst.type);
    setFormName(inst.name);
    setFormConfig({ ...inst.config });
    setShowForm(true);
  }

  async function handleSave() {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      const method = editingId ? "PUT" : "POST";
      const body = editingId
        ? { id: editingId, name: formName, type: formType, config: formConfig }
        : { type: formType, name: formName, config: formConfig };
      const resp = await fetch("/api/rtenv-providers", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error("Failed");
      toast.success(editingId ? "Updated" : "Added");
      resetForm();
      await load();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(inst: RtenvInstanceData) {
    const next = !inst.enabled;
    setInstances((prev) => prev.map((i) => i.id === inst.id ? { ...i, enabled: next } : i));
    try {
      await fetch("/api/rtenv-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: inst.id, enabled: next }),
      });
      toast.success(next ? `${inst.name} enabled` : `${inst.name} disabled`);
    } catch {
      setInstances((prev) => prev.map((i) => i.id === inst.id ? { ...i, enabled: !next } : i));
      toast.error("Failed");
    }
  }

  async function handleDelete(id: string) {
    try {
      await fetch("/api/rtenv-providers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      toast.success("Deleted");
      await load();
    } catch {
      toast.error("Failed");
    }
  }

  const typeNames: Record<string, string> = {};
  for (const s of schemas) typeNames[s.type] = s.displayName;

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <CardTitle>Runtime Environments</CardTitle>

            {!isOpen && instances.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {instances.filter((i) => i.enabled).length} active
              </span>
            )}
          </div>
          {instances.length > 0 ? (
            <Badge className="bg-green-600 text-white border-0 text-xs px-2.5">{instances.length} configured</Badge>
          ) : (
            <Badge variant="outline" className="text-xs border-muted-foreground text-muted-foreground px-2.5">
              Not configured
            </Badge>
          )}
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="space-y-3 pt-0">
          {instances.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No runtime environment instances configured. Add Supabase, Netlify, or Vercel to enable remote previews.
            </p>
          )}

          {instances.map((inst) => (
            <div key={inst.id} className={`flex items-center justify-between border rounded px-3 py-2 ${!inst.enabled ? "opacity-50" : ""}`}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={inst.enabled}
                  title={inst.enabled ? "Enabled" : "Disabled"}
                  className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${inst.enabled ? "bg-primary" : "bg-muted"}`}
                  onClick={() => handleToggle(inst)}
                >
                  <span className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-background shadow ring-0 transition-transform ${inst.enabled ? "translate-x-3" : "translate-x-0"}`} />
                </button>
                <span className="text-sm font-medium">{inst.name}</span>
                <Badge variant="outline" className="text-[10px]">{typeNames[inst.type] || inst.type}</Badge>
                {inst.config.accessToken && (
                  <Badge variant="outline" className="text-[10px] border-green-600 text-green-400">Token set</Badge>
                )}
                {inst.config.authToken && (
                  <Badge variant="outline" className="text-[10px] border-green-600 text-green-400">Token set</Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => handleStartEdit(inst)} className="text-muted-foreground hover:text-foreground p-1" title="Edit">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => handleDelete(inst.id)} className="text-muted-foreground hover:text-destructive p-1" title="Delete">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}

          {showForm ? (
            <div className="border rounded p-3 space-y-2">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Type</label>
                <select
                  className="w-full px-2 py-1 text-sm border rounded bg-background"
                  value={formType}
                  disabled={!!editingId}
                  onChange={(e) => {
                    setFormType(e.target.value);
                    const schema = schemas.find((s) => s.type === e.target.value);
                    setFormName(schema?.displayName || e.target.value);
                    setFormConfig({});
                  }}
                >
                  {schemas.map((s) => (
                    <option key={s.type} value={s.type}>{s.displayName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Name</label>
                <input className="w-full px-2 py-1 text-sm border rounded bg-background" autoComplete="off"
                  value={formName} onChange={(e) => setFormName(e.target.value)} />
              </div>
              {currentSchema?.fields.map((f) => (
                <div key={f.key}>
                  <label className="text-xs text-muted-foreground block mb-1">{f.label}</label>
                  <input
                    className="w-full px-2 py-1 text-sm border rounded bg-background font-mono"
                    type={f.type === "secret" ? "password" : "text"}
                    placeholder={f.description}
                    value={formConfig[f.key] || ""}
                    onChange={(e) => setFormConfig((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave} disabled={saving || !formName.trim()}>
                  {saving ? "..." : editingId ? "Save" : "Add"}
                </Button>
                <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="w-full"
              onClick={(e) => { e.stopPropagation(); setEditingId(null); setShowForm(true); }}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Runtime Environment
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}




// ---------------------------------------------------------------------------

const HIDDEN_INTEGRATION_NAMES = new Set(["linear", "sentry", "telegram"]);

const STORAGE_KEY = "integrations-section-order";
const DEFAULT_ORDER = ["ai-providers", "messaging", "issue-trackers", "repo-providers", "runtime-envs", "github", "local-drive"];

function loadOrder(): string[] {
  if (typeof window === "undefined") return DEFAULT_ORDER;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return DEFAULT_ORDER;
}

function saveOrder(order: string[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); } catch {}
}

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sectionOrder, setSectionOrder] = useState<string[]>(DEFAULT_ORDER);

  useEffect(() => { setSectionOrder(loadOrder()); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const integResp = await fetch("/api/integrations");
      const integData = await integResp.json();
      if (integResp.ok && Array.isArray(integData)) {
        setIntegrations(integData);
        // Add any new integration keys not yet in order
        const otherKeys = integData
          .filter((i: IntegrationData) => !HIDDEN_INTEGRATION_NAMES.has(i.name))
          .map((i: IntegrationData) => i.name);
        setSectionOrder((prev) => {
          const all = [...prev, ...otherKeys.filter((k: string) => !prev.includes(k))];
          return all;
        });
      } else {
        setError(integData.error || `HTTP ${integResp.status}`);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function moveSection(key: string, dir: -1 | 1) {
    setSectionOrder((prev) => {
      const idx = prev.indexOf(key);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      saveOrder(next);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Loading integrations...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Error: {error}</p>
      </div>
    );
  }

  const otherIntegrations = integrations.filter((i) => !HIDDEN_INTEGRATION_NAMES.has(i.name));

  // Section renderers keyed by section ID
  const sectionRenderers: Record<string, () => React.ReactNode> = {
    "ai-providers": () => <AIProvidersSection />,
    "messaging": () => <IMProvidersSection />,
    "issue-trackers": () => <IssueTrackersSection />,
    "repo-providers": () => <RepoProvidersSection />,
    "runtime-envs": () => <RuntimeEnvsSection />,
  };

  // Add "other" integrations as sections
  for (const integ of otherIntegrations) {
    sectionRenderers[integ.name] = () => {
      const isOpen = expanded[integ.name] ?? false;
      const requiredFields = integ.configSchema.filter((f) => f.required);
      const missingFields = requiredFields.filter(
        (f) => !integ.configs.find((c) => c.key === f.key && c.value)
      );

      return (
        <Card>
          <CardHeader
            className="cursor-pointer select-none"
            onClick={() => setExpanded((prev) => ({ ...prev, [integ.name]: !isOpen }))}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <CardTitle>{integ.displayName}</CardTitle>
                {integ.builtIn && <Badge variant="secondary" className="text-[10px]">Built-in</Badge>}

                {!isOpen && !integ.active && missingFields.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Missing: {missingFields.map((f) => f.label).join(", ")}
                  </span>
                )}
              </div>
              {integ.active ? (
                <Badge className="bg-green-600 text-white border-0 text-xs px-2.5">Active</Badge>
              ) : (
                <Badge variant="outline" className="text-xs border-yellow-600 text-yellow-400 px-2.5">
                  Inactive
                </Badge>
              )}
            </div>
          </CardHeader>

          {isOpen && (
            <CardContent className="space-y-4 pt-0">
              <IntegrationConfigEditor
                name={integ.name}
                configs={integ.configs}
                schema={integ.configSchema}
                onSave={load}
              />
              <IntegrationLogs name={integ.name} />
            </CardContent>
          )}
        </Card>
      );
    };
  }

  // Render sections in order, skip unknown keys
  const orderedKeys = sectionOrder.filter((k) => sectionRenderers[k]);
  // Add any sections not yet in order
  for (const k of Object.keys(sectionRenderers)) {
    if (!orderedKeys.includes(k)) orderedKeys.push(k);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 bg-background px-6 py-3 border-b border-border">
        <h1 className="text-2xl font-bold">Integrations</h1>
      </div>

      <div className="p-6 space-y-4">
        {orderedKeys.map((key, idx) => (
          <div key={key} className="relative group">
            {/* Reorder controls */}
            <div className="absolute -left-7 top-3 flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                className="text-muted-foreground hover:text-foreground p-0.5 disabled:opacity-20"
                disabled={idx === 0}
                onClick={() => moveSection(key, -1)}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                className="text-muted-foreground hover:text-foreground p-0.5 disabled:opacity-20"
                disabled={idx === orderedKeys.length - 1}
                onClick={() => moveSection(key, 1)}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            {sectionRenderers[key]()}
          </div>
        ))}

        {integrations.length === 0 && (
          <p className="text-muted-foreground text-center py-10">
            No integrations registered yet. They will appear after first startup.
          </p>
        )}
      </div>
    </div>
  );
}
