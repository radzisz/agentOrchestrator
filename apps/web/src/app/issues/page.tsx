"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus,
  Search,
  Circle,
  CircleDot,
  CheckCircle2,
  XCircle,
  Clock,
  Trash2,
  Image as ImageIcon,
} from "lucide-react";
import { extractImages, stripImages } from "@/lib/markdown-images";

interface IssueRow {
  projectName: string;
  projectPath: string;
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  phase: string;
  labels: string[];
  source: string;
  createdBy: string | null;
  createdAt: string;
  url: string | null;
  commentCount: number;
}

interface ProjectOption {
  name: string;
  path: string;
}

const PHASE_FILTERS = [
  { value: "open", label: "Open" },
  { value: "all", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const phaseIcon: Record<string, React.ReactNode> = {
  todo: <Circle className="h-4 w-4 text-muted-foreground" />,
  in_progress: <CircleDot className="h-4 w-4 text-blue-500" />,
  in_review: <Clock className="h-4 w-4 text-yellow-500" />,
  done: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  cancelled: <XCircle className="h-4 w-4 text-muted-foreground/50" />,
};

const phaseLabel: Record<string, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

export default function IssuesPage() {
  const router = useRouter();
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState("");
  const [phaseFilter, setPhaseFilter] = useState("open");
  const [projectFilter, setProjectFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createProject, setCreateProject] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createLabels, setCreateLabels] = useState("agent");
  const [creating, setCreating] = useState(false);

  // Edit dialog
  const [editIssue, setEditIssue] = useState<IssueRow | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editPhase, setEditPhase] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<IssueRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Image lightbox
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const fetchIssues = useCallback(async () => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (phaseFilter) params.set("phase", phaseFilter);
    if (projectFilter) params.set("project", projectFilter);
    if (sourceFilter) params.set("source", sourceFilter);
    try {
      const resp = await fetch(`/api/issues?${params}`);
      if (resp.ok) setIssues(await resp.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [search, phaseFilter, projectFilter, sourceFilter]);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => {
        setProjects(data.map((p: any) => ({ name: p.name, path: p.path })));
        if (data.length > 0 && !createProject) setCreateProject(data[0].name);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(fetchIssues, 200);
    return () => clearTimeout(timer);
  }, [fetchIssues]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createTitle.trim() || !createProject) return;
    setCreating(true);
    try {
      const resp = await fetch(`/api/projects/${createProject}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: createTitle.trim(),
          description: createDesc.trim() || undefined,
          labels: createLabels.split(",").map((l) => l.trim()).filter(Boolean),
        }),
      });
      if (resp.ok) {
        setCreateOpen(false);
        setCreateTitle("");
        setCreateDesc("");
        setCreateLabels("agent");
        fetchIssues();
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  }

  function openEdit(issue: IssueRow) {
    setEditIssue(issue);
    setEditTitle(issue.title);
    setEditDesc(issue.description || "");
    setEditPhase(issue.phase);
  }

  async function handleSave() {
    if (!editIssue) return;
    setSaving(true);
    try {
      await fetch(`/api/projects/${editIssue.projectName}/issues/${editIssue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDesc.trim() || null,
          phase: editPhase,
        }),
      });
      setEditIssue(null);
      fetchIssues();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${deleteTarget.projectName}/issues/${deleteTarget.id}`, {
        method: "DELETE",
      });
      setDeleteTarget(null);
      fetchIssues();
    } catch {
      // ignore
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background px-6 py-3 border-b border-border flex items-center justify-between">
        <h1 className="text-2xl font-bold">Issues</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New Issue
        </Button>
      </div>

      <div className="p-6 space-y-4">
        {/* Filters */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search issues..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <select
            value={phaseFilter}
            onChange={(e) => setPhaseFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {PHASE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>

          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All sources</option>
            <option value="local">Local</option>
            <option value="linear">Linear</option>
            <option value="sentry">Sentry</option>
          </select>

          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Issues list */}
        {loading && issues.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading...</p>
        ) : issues.length === 0 ? (
          <div className="text-center py-12 space-y-2">
            <p className="text-muted-foreground">No issues found</p>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
              Create your first issue
            </Button>
          </div>
        ) : (
          <div className="border rounded-md divide-y">
            {issues.map((issue) => {
              const allText = [issue.title, issue.description].filter(Boolean).join("\n");
              const images = extractImages(allText);
              const strippedTitle = stripImages(issue.title);
              const strippedDesc = issue.description ? stripImages(issue.description) : null;
              // If title is only images, use description as display title
              const plainTitle = strippedTitle || strippedDesc || issue.identifier;
              const plainDesc = strippedTitle ? strippedDesc : null;
              return (
                <div
                  key={issue.id}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => issue.source === "local" ? openEdit(issue) : issue.url && window.open(issue.url, "_blank")}
                >
                  <div className="mt-0.5">{phaseIcon[issue.phase]}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {issue.url ? (
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-muted-foreground shrink-0 hover:text-foreground hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {issue.identifier}
                        </a>
                      ) : (
                        <span className="text-xs font-mono text-muted-foreground shrink-0">{issue.identifier}</span>
                      )}
                      <span className="font-medium truncate">{plainTitle || issue.title}</span>
                    </div>
                    {plainDesc && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{plainDesc}</p>
                    )}
                    {/* Image thumbnails */}
                    {images.length > 0 && (
                      <div className="flex gap-1.5 mt-1.5 flex-wrap">
                        {images.map((src, i) => (
                          <button
                            key={i}
                            type="button"
                            className="relative w-16 h-16 rounded border overflow-hidden bg-muted hover:ring-2 hover:ring-primary/50 transition-all shrink-0"
                            onClick={(e) => { e.stopPropagation(); setLightboxSrc(src); }}
                            title="Click to enlarge"
                          >
                            <img
                              src={src}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[11px] text-muted-foreground">{issue.projectName}</span>
                      {issue.source && issue.source !== "local" && (
                        <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{issue.source}</Badge>
                      )}
                      {issue.labels.map((l) => (
                        <Badge key={l} variant="outline" className="text-[10px] h-4 px-1.5">{l}</Badge>
                      ))}
                      {issue.commentCount > 0 && (
                        <span className="text-[11px] text-muted-foreground">{issue.commentCount} comments</span>
                      )}
                      {images.length > 0 && (
                        <span className="text-[11px] text-muted-foreground flex items-center gap-0.5">
                          <ImageIcon className="h-3 w-3" />
                          {images.length}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {new Date(issue.createdAt).toLocaleDateString()}
                    </span>
                    {issue.source === "local" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(issue); }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Issue</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3">
            <div>
              <label className="text-sm font-medium">Project</label>
              <select
                value={createProject}
                onChange={(e) => setCreateProject(e.target.value)}
                className="mt-1 w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Title</label>
              <Input
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                placeholder="Issue title"
                autoFocus
              />
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <textarea
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[80px]"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="Optional description..."
              />
            </div>
            <div>
              <label className="text-sm font-medium text-muted-foreground">
                Labels <span className="text-xs">(comma-separated)</span>
              </label>
              <Input
                value={createLabels}
                onChange={(e) => setCreateLabels(e.target.value)}
                placeholder="agent"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={creating || !createTitle.trim()}>
                {creating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editIssue} onOpenChange={(open) => { if (!open) setEditIssue(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <span className="font-mono text-muted-foreground mr-2">{editIssue?.identifier}</span>
              Edit Issue
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Title</label>
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <textarea
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[80px]"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Status</label>
              <div className="flex gap-1 bg-muted rounded-lg p-1 mt-1">
                {(["todo", "in_progress", "in_review", "done", "cancelled"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${
                      editPhase === p ? "bg-background shadow font-medium" : "text-muted-foreground"
                    }`}
                    onClick={() => setEditPhase(p)}
                  >
                    {phaseLabel[p]}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              Project: {editIssue?.projectName} &middot; Created: {editIssue && new Date(editIssue.createdAt).toLocaleString()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditIssue(null)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || !editTitle.trim()}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete issue</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete <strong>{deleteTarget?.identifier}</strong> — {deleteTarget?.title}? This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxSrc}
            alt="Preview"
            className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white text-2xl font-bold"
            onClick={() => setLightboxSrc(null)}
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
