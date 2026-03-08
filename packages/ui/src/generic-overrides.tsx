"use client";

import type { ProjectConfigPanelProps } from "@orchestrator/contracts";
import { OverrideField } from "./override-field";

export function GenericOverrides({
  overrideFields,
  overrides,
  resolvedConfig,
  setField,
}: Pick<ProjectConfigPanelProps, "overrideFields" | "overrides" | "resolvedConfig" | "setField">) {
  return (
    <div className="space-y-2">
      <label className="text-xs text-muted-foreground block font-medium">Project overrides</label>
      {overrideFields.map((field) => {
        if (field.visibleWhen) {
          const depValue = overrides[field.visibleWhen.field] || resolvedConfig[field.visibleWhen.field] || "";
          if (depValue !== field.visibleWhen.value) return null;
        }
        return (
          <OverrideField
            key={field.key}
            field={field}
            value={overrides[field.key] || ""}
            onChange={(value) => setField(field.key, value)}
          />
        );
      })}
    </div>
  );
}
