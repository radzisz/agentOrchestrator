"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SentryMapping({
  projectName,
  initialProjects,
}: {
  projectName: string;
  initialProjects: string[];
}) {
  const [projects, setProjects] = useState<string[]>(initialProjects);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const resp = await fetch(`/api/projects/${projectName}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sentryProjects: projects.filter((p) => p.trim()),
        }),
      });
      if (!resp.ok) throw new Error("Save failed");
      toast.success("Sentry mapping saved");
      setOpen(false);
    } catch {
      toast.error("Failed to save Sentry mapping");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Sentry Projects</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            {initialProjects.length > 0 ? "Edit" : "Configure"}
          </Button>
        </CardHeader>
        {initialProjects.length > 0 && (
          <CardContent className="pt-0">
            <div className="text-xs text-muted-foreground">
              {initialProjects.join(", ")}
            </div>
          </CardContent>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Sentry Projects</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Sentry project slugs mapped to this project. Sentry alerts for these projects will create Linear issues here.
        </p>
        <div className="space-y-2">
          {projects.map((slug, idx) => (
            <div key={idx} className="flex gap-2 items-center">
              <input
                className="flex-1 px-2 py-1 text-sm border rounded bg-background font-mono"
                value={slug}
                onChange={(e) => {
                  const updated = [...projects];
                  updated[idx] = e.target.value;
                  setProjects(updated);
                }}
                placeholder="sentry-project-slug"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setProjects(projects.filter((_, i) => i !== idx))}
                className="text-destructive px-2"
              >
                x
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setProjects([...projects, ""])}
          >
            + Add
          </Button>
        </div>

        <div className="flex gap-2 pt-2">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setProjects(initialProjects);
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
