"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { FolderSearch, Check, Loader2, FolderGit2 } from "lucide-react";

interface ScannedRepo {
  name: string;
  path: string;
  alreadyAdded: boolean;
}

export function ScanProjects({ basePath }: { basePath: string }) {
  const [scanPath, setScanPath] = useState(basePath);
  const [scanning, setScanning] = useState(false);
  const [repos, setRepos] = useState<ScannedRepo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<Set<string>>(new Set());

  async function handleScan() {
    setScanning(true);
    setError(null);
    setRepos(null);
    setSelected(new Set());
    setImported(new Set());

    try {
      const resp = await fetch("/api/projects/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: scanPath }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || `HTTP ${resp.status}`);
      } else {
        setRepos(data.repos);
        // Auto-select all new repos
        const newRepos = (data.repos as ScannedRepo[]).filter((r) => !r.alreadyAdded);
        setSelected(new Set(newRepos.map((r) => r.path)));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  function toggleRepo(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAll() {
    if (!repos) return;
    const available = repos.filter((r) => !r.alreadyAdded && !imported.has(r.path));
    if (selected.size === available.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(available.map((r) => r.path)));
    }
  }

  async function handleImport() {
    setImporting(true);
    setError(null);
    const newImported = new Set(imported);

    for (const repo of repos ?? []) {
      if (!selected.has(repo.path)) continue;
      try {
        const resp = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: repo.name, repoPath: repo.path }),
        });
        if (resp.ok) {
          newImported.add(repo.path);
        }
      } catch {
        // continue with remaining
      }
    }

    setImported(newImported);
    setSelected(new Set());
    setImporting(false);

    if (newImported.size > 0) {
      window.location.reload();
    }
  }

  const newRepos = repos?.filter((r) => !r.alreadyAdded && !imported.has(r.path)) ?? [];
  const alreadyAdded = repos?.filter((r) => r.alreadyAdded || imported.has(r.path)) ?? [];

  return (
    <div className="text-center py-10 max-w-lg mx-auto space-y-4">
      <FolderSearch className="mx-auto h-10 w-10 text-muted-foreground" />
      <div>
        <p className="text-muted-foreground">No projects yet.</p>
        <p className="text-sm text-muted-foreground">
          Scan a folder to discover git repositories, or add projects manually.
        </p>
      </div>

      <div className="flex gap-2">
        <Input
          value={scanPath}
          onChange={(e) => setScanPath(e.target.value)}
          placeholder="Path to scan for git repos"
          className="text-sm"
        />
        <Button onClick={handleScan} disabled={scanning || !scanPath.trim()}>
          {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : "Scan"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {repos !== null && repos.length === 0 && (
        <p className="text-sm text-muted-foreground">No git repositories found in this directory.</p>
      )}

      {repos !== null && repos.length > 0 && (
        <Card>
          <CardContent className="p-3 space-y-1">
            {newRepos.length > 0 && (
              <div className="flex items-center justify-between mb-2">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {selected.size === newRepos.length ? "Deselect all" : "Select all"}
                </button>
                <span className="text-xs text-muted-foreground">
                  {selected.size} of {newRepos.length} selected
                </span>
              </div>
            )}

            {newRepos.map((repo) => (
              <label
                key={repo.path}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent cursor-pointer text-left"
              >
                <input
                  type="checkbox"
                  checked={selected.has(repo.path)}
                  onChange={() => toggleRepo(repo.path)}
                  className="rounded"
                />
                <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{repo.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{repo.path}</p>
                </div>
              </label>
            ))}

            {alreadyAdded.length > 0 && (
              <>
                {newRepos.length > 0 && (
                  <div className="border-t my-2" />
                )}
                {alreadyAdded.map((repo) => (
                  <div
                    key={repo.path}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 opacity-50 text-left"
                  >
                    <Check className="h-4 w-4 shrink-0 text-green-500" />
                    <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm truncate">{repo.name}</p>
                      <p className="text-xs text-muted-foreground truncate">Already added</p>
                    </div>
                  </div>
                ))}
              </>
            )}

            {newRepos.length > 0 && (
              <div className="pt-2 border-t">
                <Button
                  onClick={handleImport}
                  disabled={selected.size === 0 || importing}
                  className="w-full"
                  size="sm"
                >
                  {importing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Importing...
                    </>
                  ) : (
                    `Import ${selected.size} project${selected.size !== 1 ? "s" : ""}`
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
