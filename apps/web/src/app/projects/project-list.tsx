"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { LayoutGrid, List, Trash2, FolderOpen, AlertTriangle, Star } from "lucide-react";

interface ProjectData {
  name: string;
  path: string;
  repoUrl: string | null;
  hasGit: boolean;
  running: number;
  active: number;
  awaiting: number;
  total: number;
}

const VIEW_KEY = "projects-view";
const STARRED_KEY = "starred-projects";

function ProjectIcon({ name, size = 24 }: { name: string; size?: number }) {
  const [hasIcon, setHasIcon] = useState(true);
  if (!hasIcon) {
    return <FolderOpen style={{ width: size, height: size }} className="text-muted-foreground shrink-0" />;
  }
  return (
    <img
      src={`/api/projects/${name}/icon`}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded"
      onError={() => setHasIcon(false)}
    />
  );
}

export function ProjectList({ projects }: { projects: ProjectData[] }) {
  const router = useRouter();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [starred, setStarred] = useState<Set<string>>(new Set());

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const resp = await fetch(`/api/projects/${deleteTarget}`, { method: "DELETE" });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setDeleteError(data.error || `HTTP ${resp.status}`);
        return;
      }
      // Keep dialog open with progress until full page reload refreshes the list
      window.location.href = `/projects?t=${Date.now()}`;
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Network error");
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "list" || saved === "grid") setView(saved);
    const savedStars = JSON.parse(localStorage.getItem(STARRED_KEY) || "[]");
    setStarred(new Set(savedStars));
  }, []);

  function toggleStar(name: string) {
    setStarred(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      localStorage.setItem(STARRED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const sorted = [...projects].sort((a, b) => {
    const aS = starred.has(a.name) ? 0 : 1;
    const bS = starred.has(b.name) ? 0 : 1;
    return aS - bS;
  });

  function toggleView(v: "grid" | "list") {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-1">
        <Button
          variant={view === "grid" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => toggleView("grid")}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant={view === "list" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => toggleView("list")}
        >
          <List className="h-3.5 w-3.5" />
        </Button>
      </div>

      {view === "grid" ? (
        <div className="grid grid-cols-2 gap-4">
          {sorted.map((p) => (
            <Card
              key={p.name}
              className="cursor-pointer hover:border-foreground/30 transition-colors flex flex-col"
              onClick={() => router.push(`/projects/${p.name}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <ProjectIcon name={p.name} size={22} />
                    <CardTitle>{p.name}</CardTitle>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {p.running > 0 && <Badge className="bg-green-600 text-white">{p.running} running</Badge>}
                    {p.awaiting > 0 && <Badge variant="destructive">{p.awaiting} awaiting</Badge>}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col flex-1">
                <div className="text-xs text-muted-foreground space-y-1">
                  <p className="font-mono truncate" title={p.path}>{p.path}</p>
                  {!p.hasGit && (
                    <p className="flex items-center gap-1 text-yellow-600 dark:text-yellow-500">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      <span>No git repository — agents cannot spawn</span>
                    </p>
                  )}
                  {p.repoUrl && (
                    <p className="truncate">
                      <a href={p.repoUrl} target="_blank" className="hover:underline" onClick={(e) => e.stopPropagation()}>{p.repoUrl.replace(/^https?:\/\//, "")}</a>
                    </p>
                  )}
                  <div className="flex gap-3 pt-1">
                    <span>{p.active} active</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span>{p.total} total</span>
                  </div>
                </div>
                <div className="mt-auto pt-3 flex justify-between items-center">
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={(e) => { e.stopPropagation(); toggleStar(p.name); }}
                    >
                      <Star className={`h-3.5 w-3.5 ${starred.has(p.name) ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(p.name); }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/projects/${p.name}`} onClick={(e) => e.stopPropagation()}>Open</a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="border rounded-md divide-y">
          {sorted.map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-4 px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer"
              onClick={() => router.push(`/projects/${p.name}`)}
            >
              <ProjectIcon name={p.name} size={20} />
              <div className="flex-1 min-w-0">
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground font-mono truncate">{p.path}</div>
                {!p.hasGit && (
                  <div className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-500 mt-0.5">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    <span>No git repository — agents cannot spawn</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                {p.running > 0 && <Badge className="bg-green-600 text-white">{p.running} running</Badge>}
                {p.awaiting > 0 && <Badge variant="destructive">{p.awaiting} awaiting</Badge>}
                <span>{p.active} active</span>
                <span className="text-muted-foreground/50">·</span>
                <span>{p.total} total</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {p.repoUrl && (
                  <a
                    href={p.repoUrl}
                    target="_blank"
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Repository"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                  </a>
                )}
                <Button variant="outline" size="sm" asChild>
                  <a href={`/projects/${p.name}`} onClick={(e) => e.stopPropagation()}>Open</a>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={(e) => { e.stopPropagation(); toggleStar(p.name); }}
                >
                  <Star className={`h-3.5 w-3.5 ${starred.has(p.name) ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); setDeleteTarget(p.name); }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open && !deleting) { setDeleteTarget(null); setDeleteError(null); } }}>
        <DialogContent showCloseButton={!deleting}>
          <DialogHeader>
            <DialogTitle>Remove project</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>Are you sure you want to remove <strong>{deleteTarget}</strong> from the orchestrator?</p>
                <p>Orchestrator data (agent configs, logs, state) will remain on disk and need to be removed manually:</p>
                <code className="block text-xs bg-muted px-3 py-2 rounded font-mono break-all">
                  {projects.find((p) => p.name === deleteTarget)?.path}/.10timesdev
                </code>
                <code className="block text-xs bg-muted px-3 py-2 rounded font-mono break-all">
                  {projects.find((p) => p.name === deleteTarget)?.path}/.env.10timesdev
                </code>
              </div>
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive">{deleteError}</p>
          )}
          {deleting && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Removing project...
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteTarget(null); setDeleteError(null); }} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
