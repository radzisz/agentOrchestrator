"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FolderOpen, Check, GitBranch, AlertTriangle } from "lucide-react";

type Mode = "url" | "local";
type LocalMode = "browse" | "manual";

interface DirEntry {
  name: string;
  path: string;
  projectDir: string;
  hasGit: boolean;
  gitSubPath: string | null;
  alreadyAdded: boolean;
}

export function ProjectForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("url");
  const [localMode, setLocalMode] = useState<LocalMode>("browse");
  const [repoUrl, setRepoUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [gitInitResult, setGitInitResult] = useState<string | null>(null);

  // Directory browser state
  const [directories, setDirectories] = useState<DirEntry[]>([]);
  const [basePath, setBasePath] = useState("");
  const [dirLoading, setDirLoading] = useState(false);
  const [dirFilter, setDirFilter] = useState("");
  const [gitOnly, setGitOnly] = useState(true);

  useEffect(() => {
    if (open && mode === "local" && localMode === "browse" && directories.length === 0) {
      loadDirectories();
    }
  }, [open, mode, localMode]);

  async function loadDirectories() {
    setDirLoading(true);
    try {
      const resp = await fetch("/api/projects/directories");
      if (resp.ok) {
        const data = await resp.json();
        setDirectories(data.directories);
        setBasePath(data.basePath);
      }
    } catch {
      // ignore
    } finally {
      setDirLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);
    const body: Record<string, string | undefined> = {};

    if (mode === "url") {
      const url = repoUrl.trim();
      if (!url) {
        setError("Repository URL is required");
        setLoading(false);
        return;
      }
      body.repoUrl = url;
      const match = url.match(/\/([^/]+?)(?:\.git)?$/);
      body.name = formData.get("name") as string || (match?.[1] ?? "project");
    } else {
      const path = localPath.trim();
      if (!path) {
        setError("Local path is required");
        setLoading(false);
        return;
      }
      body.repoPath = path;
      const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
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

    const result = await resp.json().catch(() => ({}));

    setLoading(false);

    if (result.gitInitialized) {
      setGitInitResult(result.path);
    } else {
      setOpen(false);
      window.location.href = `/projects?t=${Date.now()}`;
    }
  }

  function selectDirectory(dir: DirEntry) {
    setLocalPath(dir.path);
  }

  const filteredDirs = directories.filter((d) => {
    if (d.alreadyAdded) return false;
    if (gitOnly && !d.hasGit) return false;
    if (dirFilter && !d.name.toLowerCase().includes(dirFilter.toLowerCase())) return false;
    return true;
  });
  const addedDirs = directories.filter(
    (d) => d.alreadyAdded && (!dirFilter || d.name.toLowerCase().includes(dirFilter.toLowerCase())),
  );

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>Add Project</Button>
    );
  }

  if (gitInitResult) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-card border rounded-xl p-6 w-full max-w-lg space-y-4">
          <h2 className="text-lg font-semibold">Project Created</h2>
          <div className="flex items-start gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-600 dark:text-yellow-400">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Git repository was automatically initialized</p>
              <p className="text-xs opacity-80">
                No existing git repo was found at <code className="font-mono bg-black/10 dark:bg-white/10 px-1 rounded">{gitInitResult}</code>.
                A new one was created with <code className="font-mono bg-black/10 dark:bg-white/10 px-1 rounded">git init</code>.
              </p>
              <p className="text-xs opacity-80">
                To connect to a remote, run: <code className="font-mono bg-black/10 dark:bg-white/10 px-1 rounded">git remote add origin &lt;url&gt;</code>
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => { setGitInitResult(null); setOpen(false); window.location.href = `/projects?t=${Date.now()}`; }}>
              OK
            </Button>
          </div>
        </div>
      </div>
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
              <Input key="url" name="repoUrl" placeholder="https://github.com/org/repo" autoFocus
                value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
            </div>
          ) : (
            <div className="space-y-3">
              {/* Browse / Manual toggle */}
              <div className="flex gap-1 bg-muted/50 rounded-md p-0.5">
                <button
                  type="button"
                  className={`flex-1 text-xs py-1 rounded transition-colors ${
                    localMode === "browse" ? "bg-background shadow font-medium" : "text-muted-foreground"
                  }`}
                  onClick={() => setLocalMode("browse")}
                >
                  Browse
                </button>
                <button
                  type="button"
                  className={`flex-1 text-xs py-1 rounded transition-colors ${
                    localMode === "manual" ? "bg-background shadow font-medium" : "text-muted-foreground"
                  }`}
                  onClick={() => setLocalMode("manual")}
                >
                  Enter path
                </button>
              </div>

              {localMode === "browse" ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-muted-foreground">
                      Directories in <span className="font-mono">{basePath || "..."}</span>
                    </div>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={gitOnly}
                        onChange={(e) => setGitOnly(e.target.checked)}
                        className="accent-primary w-3.5 h-3.5"
                      />
                      <span className="text-xs text-muted-foreground">git only</span>
                    </label>
                  </div>
                  <Input
                    placeholder="Filter..."
                    value={dirFilter}
                    onChange={(e) => setDirFilter(e.target.value)}
                    className="h-8 text-sm"
                  />
                  <div className="border rounded-md max-h-[280px] overflow-auto">
                    {dirLoading && (
                      <p className="text-sm text-muted-foreground p-3">Loading...</p>
                    )}
                    {!dirLoading && filteredDirs.length === 0 && addedDirs.length === 0 && (
                      <p className="text-sm text-muted-foreground p-3">No directories found</p>
                    )}
                    {filteredDirs.map((dir) => (
                      <button
                        key={dir.path}
                        type="button"
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-center gap-2 border-b last:border-b-0 ${
                          localPath === dir.path ? "bg-muted" : ""
                        }`}
                        onClick={() => selectDirectory(dir)}
                      >
                        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{dir.name}</span>
                          </div>
                          {dir.gitSubPath && (
                            <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                              <GitBranch className="w-3 h-3" />
                              repo in <span className="font-mono">{dir.gitSubPath}</span>
                            </div>
                          )}
                        </div>
                        {dir.hasGit && !dir.gitSubPath && (
                          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">git</span>
                        )}
                        {localPath === dir.path && (
                          <Check className="h-4 w-4 text-green-500 shrink-0" />
                        )}
                      </button>
                    ))}
                    {addedDirs.length > 0 && (
                      <>
                        <div className="px-3 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider bg-muted/30 border-b">
                          Already added
                        </div>
                        {addedDirs.map((dir) => (
                          <div
                            key={dir.path}
                            className="w-full text-left px-3 py-2 text-sm text-muted-foreground/60 flex items-center gap-2 border-b last:border-b-0"
                          >
                            <FolderOpen className="h-4 w-4 shrink-0" />
                            <span className="flex-1 truncate">{dir.name}</span>
                            <Check className="h-3.5 w-3.5 shrink-0" />
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                  {localPath && (
                    <div className="text-xs text-muted-foreground">
                      Selected: <span className="font-mono">{localPath}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <label className="text-sm font-medium">Local Path</label>
                  <Input key="local" name="localPath" placeholder="/path/to/project" autoFocus
                    value={localPath} onChange={(e) => setLocalPath(e.target.value)} />
                </div>
              )}
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
            <Button type="submit" disabled={loading || (mode === "local" && localMode === "browse" && !localPath)}>
              {loading ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
