"use client";

import { useState, useEffect } from "react";
import type { ProjectConfigPanelProps } from "@orchestrator/contracts";
import { OverrideField, TrashIcon, PlusIcon } from "@orchestrator/ui";

interface SentryProjectEntry {
  slug: string;
  prefix: string;
}

function autoShortName(slug: string): string {
  return slug.split("-").map((w) => w[0]).join("").toUpperCase();
}

function parseSentryProjects(projectsStr?: string, shortNamesStr?: string): SentryProjectEntry[] {
  if (!projectsStr) return [];
  const slugs = projectsStr.split(",").map((s) => s.trim()).filter(Boolean);
  const shortNames: Record<string, string> = {};
  if (shortNamesStr) {
    for (const part of shortNamesStr.split(",")) {
      const [slug, short] = part.split(":").map((s) => s.trim());
      if (slug && short) shortNames[slug] = short;
    }
  }
  return slugs.map((slug) => ({
    slug,
    prefix: shortNames[slug] || autoShortName(slug),
  }));
}

function serializeSentryProjects(entries: SentryProjectEntry[]): { projects: string; projectShortNames: string } {
  const projects = entries.map((e) => e.slug).join(",");
  const projectShortNames = entries.map((e) => `${e.slug}:${e.prefix}`).join(",");
  return { projects, projectShortNames };
}

function ensureUniquePrefix(prefix: string, existing: SentryProjectEntry[], excludeSlug?: string): string {
  const taken = new Set(existing.filter((e) => e.slug !== excludeSlug).map((e) => e.prefix));
  if (!taken.has(prefix)) return prefix;
  for (let i = 2; i < 100; i++) {
    const candidate = `${prefix}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return prefix;
}

export function SentryProjectConfigPanel({
  overrideFields,
  overrides,
  resolvedConfig,
  projectName,
  setField,
  setFields,
}: ProjectConfigPanelProps) {
  const [adding, setAdding] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newPrefix, setNewPrefix] = useState("");
  const [apiProjects, setApiProjects] = useState<Array<{ slug: string; name: string; platform: string | null }>>([]);
  const [loadedApi, setLoadedApi] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${projectName}/sentry/projects`)
      .then((r) => r.ok ? r.json() : [])
      .then((data) => setApiProjects(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoadedApi(true));
  }, [projectName]);

  const projectsRaw = overrides.projects !== undefined ? overrides.projects : resolvedConfig.projects;
  const shortNamesRaw = overrides.projectShortNames !== undefined ? overrides.projectShortNames : resolvedConfig.projectShortNames;
  const entries = parseSentryProjects(
    projectsRaw === "~" ? "" : projectsRaw,
    shortNamesRaw === "~" ? "" : shortNamesRaw,
  );

  function commitEntries(updated: SentryProjectEntry[]) {
    const { projects, projectShortNames } = serializeSentryProjects(updated);
    setFields({
      projects: projects || "~",
      projectShortNames: projectShortNames || "~",
    });
  }

  function startAdding() {
    setNewSlug("");
    setNewPrefix("");
    setAdding(true);
  }

  function confirmAdd() {
    const slug = newSlug.trim().toLowerCase();
    if (!slug || entries.some((e) => e.slug === slug)) return;
    const prefix = (newPrefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")) || autoShortName(slug);
    const unique = ensureUniquePrefix(prefix, entries);
    commitEntries([...entries, { slug, prefix: unique }]);
    setAdding(false);
  }

  function removeProject(slug: string) {
    commitEntries(entries.filter((e) => e.slug !== slug));
  }

  function onSlugChange(val: string) {
    setNewSlug(val);
    const suggested = autoShortName(val.trim().toLowerCase());
    setNewPrefix(ensureUniquePrefix(suggested, entries));
  }

  // Fields we handle manually
  const manualKeys = new Set(["projects", "projectShortNames"]);
  const genericFields = overrideFields.filter((f) => !manualKeys.has(f.key));

  return (
    <div className="space-y-3">
      <label className="text-xs text-muted-foreground block font-medium">Project settings</label>

      {/* Generic fields (org etc.) */}
      {genericFields.map((field) => {
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

      {/* Sentry projects list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-muted-foreground font-medium">Sentry Projects</label>
          {!adding && (
            <button
              className="inline-flex items-center h-6 px-2 text-xs border rounded hover:bg-muted"
              onClick={startAdding}
            >
              <PlusIcon className="h-3 w-3 mr-1" /> Add
            </button>
          )}
        </div>

        {/* Project list */}
        {entries.length > 0 && (
          <div className="space-y-1 mb-2">
            {entries.map((entry) => (
              <div key={entry.slug} className="flex items-center gap-2 bg-muted/30 rounded px-2 py-1.5">
                <span className="px-1.5 py-0.5 text-xs font-mono font-bold bg-foreground/10 rounded min-w-[3ch] text-center">
                  {entry.prefix}
                </span>
                <span className="flex-1 text-sm truncate">{entry.slug}</span>
                <span className="text-[10px] text-muted-foreground/60 font-mono">{entry.prefix}-42</span>
                <button
                  className="text-muted-foreground hover:text-destructive p-0.5"
                  onClick={() => removeProject(entry.slug)}
                >
                  <TrashIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {entries.length === 0 && !adding && (
          <p className="text-[11px] text-muted-foreground">No projects configured</p>
        )}

        {/* Add form */}
        {adding && (
          <div className="border rounded p-2 space-y-2 bg-muted/20">
            <div>
              <label className="text-[11px] text-muted-foreground block mb-1">Project</label>
              {(() => {
                const available = apiProjects.filter((p: { slug: string }) => !entries.some((e: SentryProjectEntry) => e.slug === p.slug));
                if (available.length > 0) {
                  return (
                    <select
                      className="w-full px-2 py-1 text-sm border rounded bg-background"
                      value={newSlug}
                      onChange={(e) => onSlugChange(e.target.value)}
                      autoFocus
                    >
                      <option value="">Select project...</option>
                      {available.map((p: { slug: string; name: string; platform: string | null }) => (
                        <option key={p.slug} value={p.slug}>
                          {p.slug}{p.name !== p.slug ? ` (${p.name})` : ""}{p.platform ? ` [${p.platform}]` : ""}
                        </option>
                      ))}
                    </select>
                  );
                }
                return (
                  <>
                    <input
                      className="w-full px-2 py-1 text-sm border rounded bg-background"
                      value={newSlug}
                      onChange={(e) => onSlugChange(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && confirmAdd()}
                      placeholder="e.g. my-app-frontend"
                      autoFocus
                    />
                    {loadedApi && (
                      <p className="text-[10px] text-amber-500 mt-1">
                        Could not load project list — token may be missing <code className="font-mono">org:read</code> scope.
                        Enter slug manually.
                      </p>
                    )}
                  </>
                );
              })()}
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground block mb-1">Issue prefix</label>
              <div className="flex items-center gap-2">
                <input
                  className="w-24 px-2 py-1 text-sm font-mono border rounded bg-background uppercase"
                  value={newPrefix}
                  onChange={(e) => setNewPrefix(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && confirmAdd()}
                  placeholder="e.g. MAF"
                />
                <span className="text-[11px] text-muted-foreground font-mono">
                  {newPrefix ? `${newPrefix.toUpperCase()}-42` : ""}
                </span>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button className="px-3 py-1 text-sm border rounded hover:bg-muted" onClick={confirmAdd} disabled={!newSlug.trim()}>OK</button>
              <button className="px-3 py-1 text-sm hover:bg-muted rounded" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
