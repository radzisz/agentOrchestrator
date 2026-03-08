"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GenericOverrides, OverrideField, TrashIcon, PlusIcon } from "@orchestrator/ui";
import { SentryProjectConfigPanel } from "@orchestrator/tracker-sentry";
import { LinearProjectConfigPanel } from "@orchestrator/tracker-linear";
import type { ConfigField, ProjectConfigPanelProps } from "@orchestrator/contracts";
import type { ComponentType } from "react";

// ---------------------------------------------------------------------------
// Registry of tracker-specific config panels
// ---------------------------------------------------------------------------

const configPanels: Record<string, ComponentType<ProjectConfigPanelProps>> = {
  sentry: SentryProjectConfigPanel,
  linear: LinearProjectConfigPanel,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrackerTypeSchema {
  type: string;
  displayName: string;
  fields: ConfigField[];
}

interface TrackerInstance {
  id: string;
  type: string;
  name: string;
  isDefault: boolean;
  config: Record<string, string>;
}

interface TrackerEntry {
  type: string;
  displayName: string;
  enabled: boolean;
  instanceId?: string;
  instanceName?: string;
  overrides?: Record<string, string>;
  resolvedConfig: Record<string, string> | null;
}

interface TrackerEntryState extends TrackerEntry {
  _idx: number;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TrackerSettings({ projectName }: { projectName: string }) {
  const [schemas, setSchemas] = useState<TrackerTypeSchema[]>([]);
  const [trackers, setTrackers] = useState<TrackerEntryState[]>([]);
  const [instances, setInstances] = useState<TrackerInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [trackersResp, instancesResp] = await Promise.all([
        fetch(`/api/projects/${projectName}/trackers`),
        fetch("/api/tracker-instances"),
      ]);
      if (trackersResp.ok) {
        const data = await trackersResp.json();
        setTrackers((data.trackers || []).map((t: TrackerEntry, i: number) => ({ ...t, _idx: i })));
        setSchemas(data.schemas);
      }
      if (instancesResp.ok) {
        const data = await instancesResp.json();
        setInstances(data.instances);
      }
    } catch {
      toast.error("Failed to load tracker config");
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function save(updated: TrackerEntryState[]) {
    const payload = updated.map((t) => ({
      type: t.type,
      enabled: t.enabled,
      instanceId: t.instanceId,
      overrides: t.overrides,
    }));
    try {
      const resp = await fetch(`/api/projects/${projectName}/trackers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackers: payload }),
      });
      if (!resp.ok) throw new Error();
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  function updateEntry(idx: number, patch: Partial<TrackerEntry>) {
    const updated = trackers.map((t) =>
      t._idx === idx ? { ...t, ...patch } : t
    );
    setTrackers(updated);
    save(updated);
  }

  function removeEntry(idx: number) {
    const updated = trackers.filter((t) => t._idx !== idx);
    setTrackers(updated);
    save(updated);
  }

  function addEntry(type: string, instanceId?: string, overrides?: Record<string, string>) {
    const schema = schemas.find((s) => s.type === type);
    const newIdx = trackers.length > 0 ? Math.max(...trackers.map((t) => t._idx)) + 1 : 0;
    const cleanOverrides = overrides
      ? Object.fromEntries(Object.entries(overrides).filter(([, v]) => v))
      : undefined;
    const entry: TrackerEntryState = {
      _idx: newIdx,
      type,
      displayName: schema?.displayName || type,
      enabled: true,
      instanceId,
      overrides: cleanOverrides && Object.keys(cleanOverrides).length > 0 ? cleanOverrides : undefined,
      resolvedConfig: null,
    };
    const updated = [...trackers, entry];
    setTrackers(updated);
    save(updated).then(() => fetchData());
    setShowAdd(false);
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading tracker config...</div>;
  }

  const hasEnabledTracker = trackers.some((t) => t.enabled);

  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm">Issue Trackers</CardTitle>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
              hasEnabledTracker
                ? "bg-green-500/15 text-green-600 dark:text-green-400"
                : "bg-red-500/15 text-red-600 dark:text-red-400"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${hasEnabledTracker ? "bg-green-500" : "bg-red-500"}`} />
              {hasEnabledTracker ? "Configured" : "Needs setup"}
            </span>
          </div>
          <button
            className="inline-flex items-center h-7 px-2 text-xs border rounded hover:bg-muted"
            onClick={() => setShowAdd(!showAdd)}
          >
            {showAdd ? "Cancel" : <><PlusIcon className="h-3.5 w-3.5 mr-1" /> Add</>}
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {trackers.length === 0 && !showAdd && (
          <p className="text-xs text-muted-foreground">No issue trackers configured for this project.</p>
        )}

        {trackers.map((entry) => {
          const schema = schemas.find((s) => s.type === entry.type);
          const typeInstances = instances.filter((i) => i.type === entry.type);
          const overrideFields = schema?.fields.filter((f) => f.projectOverride) || [];

          return (
            <TrackerEntryCard
              key={entry._idx}
              projectName={projectName}
              entry={entry}
              schema={schema}
              instances={typeInstances}
              overrideFields={overrideFields}
              onToggle={(enabled) => updateEntry(entry._idx, { enabled })}
              onInstanceChange={(instanceId) => updateEntry(entry._idx, { instanceId })}
              onOverridesChange={(overrides) => updateEntry(entry._idx, { overrides })}
              onRemove={() => removeEntry(entry._idx)}
              onInstanceCreated={fetchData}
            />
          );
        })}

        {showAdd && (
          <AddTrackerForm
            schemas={schemas}
            instances={instances}
            projectName={projectName}
            onAdd={addEntry}
            onCancel={() => setShowAdd(false)}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Single tracker entry card
// ---------------------------------------------------------------------------

function TrackerEntryCard({
  projectName,
  entry,
  schema,
  instances,
  overrideFields,
  onToggle,
  onInstanceChange,
  onOverridesChange,
  onRemove,
}: {
  projectName: string;
  entry: TrackerEntryState;
  schema: TrackerTypeSchema | undefined;
  instances: TrackerInstance[];
  overrideFields: ConfigField[];
  onToggle: (enabled: boolean) => void;
  onInstanceChange: (instanceId: string | undefined) => void;
  onOverridesChange: (overrides: Record<string, string>) => void;
  onRemove: () => void;
  onInstanceCreated: () => void;
}) {
  const hasRequiredOverrides = overrideFields.some((f) => f.required);
  const missingRequired = hasRequiredOverrides && overrideFields.some((f) => f.required && !entry.overrides?.[f.key]);
  const [expanded, setExpanded] = useState(missingRequired);
  const selectedInstance = instances.find((i) => i.id === entry.instanceId) || instances[0];
  const displayName = schema?.displayName || entry.type;

  const overrideSummary = entry.overrides
    ? Object.entries(entry.overrides)
        .filter(([, v]) => v)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "";

  return (
    <div className="border rounded">
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className={`w-2 h-2 rounded-full shrink-0 ${entry.enabled ? "bg-green-500" : "bg-muted-foreground/30"}`} />
        <span className="text-sm font-medium">{displayName}</span>
        {selectedInstance && (
          <span className="text-xs text-muted-foreground">({selectedInstance.name})</span>
        )}
        {overrideSummary && (
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">{overrideSummary}</span>
        )}
        <div className="flex-1" />
        <button
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${entry.enabled ? "bg-foreground" : "bg-muted-foreground/30"}`}
          onClick={(e) => { e.stopPropagation(); onToggle(!entry.enabled); }}
        >
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background transition-transform ${entry.enabled ? "translate-x-4.5" : "translate-x-1"}`} />
        </button>
        <button
          className="text-muted-foreground hover:text-destructive p-1 shrink-0"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="border-t px-3 py-3 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Instance</label>
            <select
              className="w-full px-2 py-1 text-sm border rounded bg-background"
              value={entry.instanceId || ""}
              onChange={(e) => onInstanceChange(e.target.value || undefined)}
            >
              {instances.length === 0 && <option value="">No instances configured</option>}
              {instances.map((inst) => (
                <option key={inst.id} value={inst.id}>{inst.name}</option>
              ))}
            </select>
          </div>

          {overrideFields.length > 0 && instances.length > 0 && (
            <TrackerOverrideFields
              trackerType={entry.type}
              overrideFields={overrideFields}
              overrides={entry.overrides || {}}
              resolvedConfig={entry.resolvedConfig || {}}
              projectName={projectName}
              onChange={onOverridesChange}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tracker Override Fields — dispatches to registered panel or generic fallback
// ---------------------------------------------------------------------------

function TrackerOverrideFields({
  trackerType,
  overrideFields,
  overrides,
  resolvedConfig,
  projectName,
  onChange,
}: {
  trackerType: string;
  overrideFields: ConfigField[];
  overrides: Record<string, string>;
  resolvedConfig: Record<string, string>;
  projectName: string;
  onChange: (overrides: Record<string, string>) => void;
}) {
  function setField(key: string, value: string) {
    setFields({ [key]: value });
  }

  function setFields(patch: Record<string, string>) {
    const updated = { ...overrides, ...patch };
    for (const k of Object.keys(updated)) {
      if (!updated[k] && updated[k] !== "~") delete updated[k];
    }
    onChange(updated);
  }

  const Panel = configPanels[trackerType];
  if (Panel) {
    return (
      <Panel
        overrideFields={overrideFields}
        overrides={overrides}
        resolvedConfig={resolvedConfig}
        projectName={projectName}
        setField={setField}
        setFields={setFields}
      />
    );
  }

  // Generic fallback
  return (
    <GenericOverrides
      overrideFields={overrideFields}
      overrides={overrides}
      resolvedConfig={resolvedConfig}
      setField={setField}
    />
  );
}

// ---------------------------------------------------------------------------
// Add tracker form
// ---------------------------------------------------------------------------

function AddTrackerForm({
  schemas,
  instances,
  projectName,
  onAdd,
  onCancel,
}: {
  schemas: TrackerTypeSchema[];
  instances: TrackerInstance[];
  projectName: string;
  onAdd: (type: string, instanceId?: string, overrides?: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [selectedInstanceId, setSelectedInstanceId] = useState(instances[0]?.id || "");
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const selectedInstance = instances.find((i) => i.id === selectedInstanceId);
  const type = selectedInstance?.type || schemas[0]?.type || "";
  const schema = schemas.find((s) => s.type === type);
  const overrideFields = schema?.fields.filter((f) => f.projectOverride) || [];

  useEffect(() => {
    setOverrides({});
  }, [selectedInstanceId]);

  return (
    <div className="border rounded p-3 space-y-3 bg-muted/30">
      <div>
        <label className="text-xs text-muted-foreground block mb-1">Instance</label>
        <select
          className="w-full px-2 py-1 text-sm border rounded bg-background"
          value={selectedInstanceId}
          onChange={(e) => setSelectedInstanceId(e.target.value)}
        >
          {instances.length === 0 && <option value="">No instances — create one in Integrations first</option>}
          {instances.map((inst) => {
            const s = schemas.find((sc) => sc.type === inst.type);
            return (
              <option key={inst.id} value={inst.id}>
                {s?.displayName || inst.type} — {inst.name}
              </option>
            );
          })}
        </select>
      </div>

      {overrideFields.length > 0 && instances.length > 0 && (
        <div className="border-t pt-3">
          <TrackerOverrideFields
            trackerType={type}
            overrideFields={overrideFields}
            overrides={overrides}
            resolvedConfig={{}}
            projectName={projectName}
            onChange={setOverrides}
          />
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          className="px-3 py-1 text-sm border rounded hover:bg-muted"
          onClick={() => onAdd(type, selectedInstanceId || undefined, overrides)}
          disabled={!type || instances.length === 0}
        >
          Add
        </button>
        <button className="px-3 py-1 text-sm hover:bg-muted rounded" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
