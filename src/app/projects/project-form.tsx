"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Mode = "url" | "local";

export function ProjectForm() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("url");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    const body: Record<string, string | undefined> = {};

    if (mode === "url") {
      const repoUrl = (formData.get("repoUrl") as string).trim();
      if (!repoUrl) {
        setError("Repository URL is required");
        setLoading(false);
        return;
      }
      body.repoUrl = repoUrl;
      // Derive name from URL: "https://github.com/org/my-repo" → "my-repo"
      const match = repoUrl.match(/\/([^/]+?)(?:\.git)?$/);
      body.name = formData.get("name") as string || (match?.[1] ?? "project");
    } else {
      const localPath = (formData.get("localPath") as string).trim();
      if (!localPath) {
        setError("Local path is required");
        setLoading(false);
        return;
      }
      body.repoPath = localPath;
      // Derive name from path: "D:/git/my-project" → "my-project"
      const parts = localPath.replace(/\\/g, "/").split("/").filter(Boolean);
      body.name = formData.get("name") as string || parts[parts.length - 1] || "project";
    }

    const resp = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      setError(data.error || `HTTP ${resp.status}`);
      setLoading(false);
      return;
    }

    setLoading(false);
    setOpen(false);
    window.location.reload();
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>Add Project</Button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border rounded-xl p-6 w-full max-w-lg space-y-4">
        <h2 className="text-lg font-semibold">Add Project</h2>

        {/* Mode toggle */}
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          <button
            type="button"
            className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${
              mode === "url" ? "bg-background shadow font-medium" : "text-muted-foreground"
            }`}
            onClick={() => setMode("url")}
          >
            Git URL
          </button>
          <button
            type="button"
            className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${
              mode === "local" ? "bg-background shadow font-medium" : "text-muted-foreground"
            }`}
            onClick={() => setMode("local")}
          >
            Local Directory
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "url" ? (
            <div>
              <label className="text-sm font-medium">Repository URL</label>
              <Input name="repoUrl" placeholder="https://github.com/org/repo" autoFocus />
            </div>
          ) : (
            <div>
              <label className="text-sm font-medium">Local Path</label>
              <Input name="localPath" placeholder="D:/git/my-project" autoFocus />
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-muted-foreground">
              Project Name <span className="text-xs">(auto-detected, override if needed)</span>
            </label>
            <Input name="name" placeholder="auto" />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" type="button" onClick={() => { setOpen(false); setError(null); }}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
