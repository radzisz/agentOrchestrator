"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ColumnDef {
  key: string;
  label: string;
  placeholder?: string;
}

interface RtenvFieldSchema {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  description?: string;
  columns?: ColumnDef[];
}

interface RtenvSchema {
  type: string;
  displayName: string;
  fields: Array<{ key: string; label: string; type: string; required?: boolean; description?: string }>;
  projectFields: RtenvFieldSchema[];
}

interface RtenvInstance {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
}

// Per-project rtenv config stored as RTENV_CONFIG
export interface ProjectRtenvConfig {
  [type: string]: {
    enabled: boolean;
    instanceId?: string;
    projectConfig: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// List Field Editor — editable rows with add/remove
// ---------------------------------------------------------------------------

function ListFieldEditor({
  field,
  value,
  onChange,
}: {
  field: RtenvFieldSchema;
  value: string;
  onChange: (val: string) => void;
}) {
  const columns = field.columns || [];

  let items: Record<string, string>[] = [];
  try {
    const parsed = JSON.parse(value || "[]");
    if (Array.isArray(parsed)) items = parsed;
  } catch {}

  function update(newItems: Record<string, string>[]) {
    onChange(JSON.stringify(newItems));
  }

  function updateItem(idx: number, col: string, val: string) {
    const next = items.map((item, i) => (i === idx ? { ...item, [col]: val } : item));
    update(next);
  }

  function addItem() {
    const empty: Record<string, string> = {};
    for (const c of columns) empty[c.key] = "";
    update([...items, empty]);
  }

  function removeItem(idx: number) {
    update(items.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-muted-foreground">
          {field.label}
          {field.required && <span className="text-red-400 ml-0.5">*</span>}
        </label>
        <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={addItem}>
          + Add
        </Button>
      </div>
      {field.description && (
        <p className="text-[10px] text-muted-foreground mb-1">{field.description}</p>
      )}

      {/* Column headers */}
      {items.length > 0 && (
        <div className={`grid gap-2 items-center mb-1`} style={{ gridTemplateColumns: `${columns.map(() => "1fr").join(" ")} auto` }}>
          {columns.map((col) => (
            <span key={col.key} className="text-[10px] text-muted-foreground font-medium">{col.label}</span>
          ))}
          <span />
        </div>
      )}

      {/* Rows */}
      <div className="space-y-1">
        {items.map((item, idx) => (
          <div
            key={idx}
            className="grid gap-2 items-center"
            style={{ gridTemplateColumns: `${columns.map(() => "1fr").join(" ")} auto` }}
          >
            {columns.map((col) => (
              <input
                key={col.key}
                className="px-2 py-1 text-sm border rounded bg-background font-mono"
                value={item[col.key] || ""}
                onChange={(e) => updateItem(idx, col.key, e.target.value)}
                placeholder={col.placeholder || col.label}
              />
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeItem(idx)}
              className="text-destructive px-2 h-7"
            >
              ×
            </Button>
          </div>
        ))}
      </div>

      {items.length === 0 && (
        <p className="text-[10px] text-muted-foreground italic">No items. Click + Add to add one.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsed summary for a list field
// ---------------------------------------------------------------------------

function listSummary(field: RtenvFieldSchema, value: string): string {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed) || parsed.length === 0) return "None";
    const firstCol = field.columns?.[0]?.key || "name";
    return parsed.map((item: any) => item[firstCol] || "?").join(", ");
  } catch {
    return value || "Not set";
  }
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function RemoteConfig({
  projectName,
  initialRtenvConfig,
  enabled,
  onToggle,
}: {
  projectName: string;
  initialRtenvConfig: ProjectRtenvConfig;
  enabled: boolean;
  onToggle: () => void;
}) {
  const [schemas, setSchemas] = useState<RtenvSchema[]>([]);
  const [instances, setInstances] = useState<RtenvInstance[]>([]);
  const [rtenvConfig, setRtenvConfig] = useState<ProjectRtenvConfig>(initialRtenvConfig);
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/rtenv-providers")
      .then((r) => r.json())
      .then((data) => {
        setSchemas(data.schemas || []);
        setInstances(data.instances || []);
      })
      .catch(() => {});
  }, []);

  async function saveConfig(updated: ProjectRtenvConfig) {
    setSaving(true);
    try {
      const resp = await fetch(`/api/projects/${projectName}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtenvConfig: updated }),
      });
      if (!resp.ok) throw new Error("Save failed");
      toast.success("Remote config saved");
    } catch {
      toast.error("Failed to save remote config");
    } finally {
      setSaving(false);
    }
  }

  function toggleType(type: string) {
    const current = rtenvConfig[type] || { enabled: false, projectConfig: {} };
    const updated = {
      ...rtenvConfig,
      [type]: { ...current, enabled: !current.enabled },
    };
    setRtenvConfig(updated);
    saveConfig(updated);
  }

  function setInstanceId(type: string, instanceId: string) {
    const current = rtenvConfig[type] || { enabled: true, projectConfig: {} };
    const updated = {
      ...rtenvConfig,
      [type]: { ...current, enabled: true, instanceId: instanceId || undefined },
    };
    setRtenvConfig(updated);
    saveConfig(updated);
  }

  function updateProjectField(type: string, key: string, value: string) {
    const current = rtenvConfig[type] || { enabled: true, projectConfig: {} };
    const updated = {
      ...rtenvConfig,
      [type]: {
        ...current,
        enabled: true,
        projectConfig: { ...current.projectConfig, [key]: value },
      },
    };
    setRtenvConfig(updated);
  }

  function saveProjectFields() {
    saveConfig(rtenvConfig);
    setExpandedType(null);
  }

  const activeTypes = schemas.filter((s) => rtenvConfig[s.type]?.enabled);
  const inactiveTypes = schemas.filter((s) => !rtenvConfig[s.type]?.enabled);

  return (
    <Card className={!enabled ? "opacity-50" : ""}>
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className={`w-8 h-4 rounded-full transition-colors relative ${enabled ? "bg-green-500" : "bg-muted"}`}
          >
            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? "left-4" : "left-0.5"}`} />
          </button>
          <CardTitle className="text-sm">Remote</CardTitle>
        </div>
      </CardHeader>

      {enabled && (
        <CardContent className="space-y-3 pt-0">
          {/* Active providers */}
          {activeTypes.map((schema) => {
            const cfg = rtenvConfig[schema.type]!;
            const typeInstances = instances.filter((i) => i.type === schema.type && i.enabled);
            const selectedInstance = cfg.instanceId
              ? instances.find((i) => i.id === cfg.instanceId)
              : typeInstances[0];
            const isExpanded = expandedType === schema.type;

            return (
              <div key={schema.type} className="border rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleType(schema.type)}
                      className="w-7 h-3.5 rounded-full transition-colors relative bg-green-500"
                    >
                      <span className="absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white left-3.5" />
                    </button>
                    <span className="text-sm font-medium">{schema.displayName}</span>
                    {!selectedInstance && (
                      <span className="text-[10px] bg-yellow-500/15 text-yellow-500 px-1.5 py-0.5 rounded">
                        no instance
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => setExpandedType(isExpanded ? null : schema.type)}
                  >
                    {isExpanded ? "Close" : "Edit"}
                  </Button>
                </div>

                {/* Collapsed summary */}
                {!isExpanded && (
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {selectedInstance && (
                      <div>Instance: {selectedInstance.name}</div>
                    )}
                    {schema.projectFields.map((f) => (
                      <div key={f.key}>
                        {f.label}:{" "}
                        {f.type === "list"
                          ? listSummary(f, cfg.projectConfig[f.key])
                          : cfg.projectConfig[f.key] || "Not set"}
                      </div>
                    ))}
                  </div>
                )}

                {/* Expanded editor */}
                {isExpanded && (
                  <div className="space-y-3 mt-2">
                    {/* Instance selector */}
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Instance</label>
                      {typeInstances.length > 0 ? (
                        <select
                          className="w-full px-2 py-1 text-sm border rounded bg-background"
                          value={cfg.instanceId || ""}
                          onChange={(e) => setInstanceId(schema.type, e.target.value)}
                        >
                          {typeInstances.length === 1 ? null : <option value="">Default (first available)</option>}
                          {typeInstances.map((inst) => (
                            <option key={inst.id} value={inst.id}>
                              {inst.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          No {schema.displayName} instances configured.{" "}
                          <a href="/integrations" className="underline">Add one</a>.
                        </p>
                      )}
                    </div>

                    {/* Project-specific fields */}
                    {schema.projectFields.map((field) =>
                      field.type === "list" ? (
                        <ListFieldEditor
                          key={field.key}
                          field={field}
                          value={cfg.projectConfig[field.key] || "[]"}
                          onChange={(val) => updateProjectField(schema.type, field.key, val)}
                        />
                      ) : (
                        <div key={field.key}>
                          <label className="text-xs text-muted-foreground block mb-1">
                            {field.label}
                            {field.required && <span className="text-red-400 ml-0.5">*</span>}
                          </label>
                          {field.description && (
                            <p className="text-[10px] text-muted-foreground mb-1">{field.description}</p>
                          )}
                          <input
                            className="w-full px-2 py-1 text-sm border rounded bg-background font-mono"
                            type={field.type === "secret" ? "password" : "text"}
                            value={cfg.projectConfig[field.key] || ""}
                            onChange={(e) => updateProjectField(schema.type, field.key, e.target.value)}
                            placeholder={field.description || field.label}
                          />
                        </div>
                      )
                    )}

                    <div className="flex gap-2">
                      <Button size="sm" className="h-7 text-xs" onClick={saveProjectFields} disabled={saving}>
                        {saving ? "Saving..." : "Save"}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setExpandedType(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Inactive providers — simple enable buttons */}
          {inactiveTypes.length > 0 && (
            <div className="space-y-1">
              {inactiveTypes.map((schema) => {
                const typeInstances = instances.filter((i) => i.type === schema.type && i.enabled);
                return (
                  <div key={schema.type} className="flex items-center justify-between py-1.5 px-3 border rounded-md opacity-60 hover:opacity-100 transition-opacity">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleType(schema.type)}
                        className="w-7 h-3.5 rounded-full transition-colors relative bg-muted"
                      >
                        <span className="absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white left-0.5" />
                      </button>
                      <span className="text-sm">{schema.displayName}</span>
                      {typeInstances.length === 0 && (
                        <span className="text-[10px] text-muted-foreground">(no instances)</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {schemas.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No runtime environment providers configured.{" "}
              <a href="/integrations" className="underline">Configure them in Integrations</a>.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
