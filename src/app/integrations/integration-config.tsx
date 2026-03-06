"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ConfigField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "secret" | "select";
  required?: boolean;
  description?: string;
  default?: string;
  options?: Array<{ label: string; value: string }>;
}

interface ConfigEntry {
  key: string;
  value: string;
}

export function IntegrationConfigEditor({
  name,
  configs,
  schema,
  onSave,
}: {
  name: string;
  configs: ConfigEntry[];
  schema?: ConfigField[];
  onSave: () => void;
}) {
  // Build display list: schema fields first, then any extra config keys not in schema
  const configMap = new Map(configs.map((c) => [c.key, c.value]));
  const schemaKeys = new Set((schema || []).map((f) => f.key));

  const fields: Array<ConfigField & { currentValue: string }> = [];

  // Schema-defined fields
  for (const field of schema || []) {
    fields.push({
      ...field,
      currentValue: configMap.get(field.key) || "",
    });
  }

  // Extra keys not in schema (e.g. dynamic/cached values)
  for (const [key, value] of configMap) {
    if (!schemaKeys.has(key)) {
      fields.push({
        key,
        label: key,
        type: "string",
        currentValue: value,
      });
    }
  }

  if (fields.length === 0) {
    return <p className="text-xs text-muted-foreground">No configuration needed</p>;
  }

  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <ConfigRow
          key={field.key}
          integrationName={name}
          field={field}
          value={field.currentValue}
          onSave={onSave}
        />
      ))}
    </div>
  );
}

function ConfigRow({
  integrationName,
  field,
  value,
  onSave,
}: {
  integrationName: string;
  field: ConfigField;
  value: string;
  onSave: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const isSecret = field.type === "secret";
  const hasValue = value && value.length > 0;
  const isMissing = field.required && !hasValue;

  async function updateValue(newValue: string) {
    setSaving(true);
    try {
      const resp = await fetch("/api/integrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: integrationName, configs: { [field.key]: newValue } }),
      });
      if (!resp.ok) throw new Error("Save failed");
      toast.success("Saved");
      setEditing(false);
      onSave();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Select field — button group
  if (field.type === "select" && field.options) {
    return (
      <div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground min-w-[120px]">
            {field.label}
            {field.required && <span className="text-red-400 ml-0.5">*</span>}
          </span>
          <div className="flex gap-1">
            {field.options.map((opt) => (
              <Button
                key={opt.value}
                variant={value === opt.value ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                disabled={saving}
                onClick={() => updateValue(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>
        {field.description && (
          <p className="text-[11px] text-muted-foreground mt-0.5 ml-[132px]">{field.description}</p>
        )}
      </div>
    );
  }

  // Editing mode
  if (editing) {
    return (
      <div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground min-w-[120px]">
            {field.label}
            {field.required && <span className="text-red-400 ml-0.5">*</span>}
          </span>
          <Input
            type={isSecret ? "password" : "text"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-7 text-sm max-w-sm"
            autoFocus
            placeholder={field.default || ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") updateValue(draft);
              if (e.key === "Escape") { setEditing(false); setDraft(value); }
            }}
          />
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={saving || draft === value}
            onClick={() => updateValue(draft)}
          >
            {saving ? "..." : "Save"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => { setEditing(false); setDraft(value); }}
          >
            Cancel
          </Button>
        </div>
        {field.description && (
          <p className="text-[11px] text-muted-foreground mt-0.5 ml-[132px]">{field.description}</p>
        )}
      </div>
    );
  }

  // Display mode
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <span className={`min-w-[120px] ${isMissing ? "text-yellow-400" : "text-muted-foreground"}`}>
          {field.label}
          {field.required && <span className="text-red-400 ml-0.5">*</span>}
        </span>
        {hasValue ? (
          <span className="font-mono text-sm">{isSecret ? "••••••••" : value}</span>
        ) : (
          <span className={`italic ${isMissing ? "text-yellow-400" : "text-muted-foreground"}`}>
            {isMissing ? "required" : "not set"}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs px-2"
          onClick={() => { setDraft(isSecret ? "" : value); setEditing(true); }}
        >
          {hasValue ? "Edit" : "Set"}
        </Button>
      </div>
      {field.description && !isMissing && (
        <p className="text-[11px] text-muted-foreground mt-0.5 ml-[132px]">{field.description}</p>
      )}
    </div>
  );
}
