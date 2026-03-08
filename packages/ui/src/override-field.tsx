"use client";

import { useState, useEffect } from "react";
import type { ConfigField } from "@orchestrator/contracts";

export interface OverrideFieldProps {
  field: ConfigField;
  value: string;
  onChange: (value: string) => void;
}

export function OverrideField({ field, value, onChange }: OverrideFieldProps) {
  const [local, setLocal] = useState(value);

  useEffect(() => { setLocal(value); }, [value]);

  if (field.type === "select" && field.options) {
    return (
      <div>
        <label className="text-xs text-muted-foreground block mb-1">{field.label}</label>
        <select
          className="w-full px-2 py-1 text-sm border rounded bg-background"
          value={local || field.default || ""}
          onChange={(e) => {
            setLocal(e.target.value);
            onChange(e.target.value);
          }}
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">{field.label}</label>
      <div className="flex gap-2">
        <input
          className="flex-1 px-2 py-1 text-sm border rounded bg-background"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          placeholder={field.default || field.description || ""}
        />
        {local !== value && (
          <button
            className="px-2 py-1 text-xs border rounded hover:bg-muted"
            onClick={() => onChange(local)}
          >
            Save
          </button>
        )}
      </div>
    </div>
  );
}
