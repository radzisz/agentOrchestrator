"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GitMerge, Ban, Trash2, AlertTriangle, Loader2 } from "lucide-react";

type DialogType = "merge" | "reject" | "remove" | null;

interface DirtyInfo {
  loading: boolean;
  hasUncommitted: boolean;
  files: string[];
}

interface UiStatus {
  status: "starting" | "running" | "awaiting" | "closing" | "closed";
  reason?: "completed" | "error" | "conflict";
}

export function AgentActions({
  agentId,
  projectName,
  uiStatus,
}: {
  agentId: string;
  projectName: string;
  uiStatus: UiStatus;
}) {
  const [openDialog, setOpenDialog] = useState<DialogType>(null);
  const [dirty, setDirty] = useState<DirtyInfo>({ loading: true, hasUncommitted: false, files: [] });
  const [actionLoading, setActionLoading] = useState(false);
  const [cleanupOnMerge, setCleanupOnMerge] = useState(true);
  const [cleanupOnReject, setCleanupOnReject] = useState(true);
  const [closeIssueOnMerge, setCloseIssueOnMerge] = useState(true);
  const [closeIssueOnReject, setCloseIssueOnReject] = useState(true);
  const [closeIssueOnRemove, setCloseIssueOnRemove] = useState(true);
  const [ignoreSelection, setIgnoreSelection] = useState<Set<string>>(new Set());
  const [commitMsg, setCommitMsg] = useState("");

  // Listen for dialog triggers from NextSteps (agent-state-panel.tsx)
  useEffect(() => {
    function handleOpenMerge() { openConfirm("merge"); }
    function handleOpenReject() { openConfirm("reject"); }
    function handleOpenRemove() { openConfirm("remove"); }
    window.addEventListener("open-merge-dialog", handleOpenMerge);
    window.addEventListener("open-reject-dialog", handleOpenReject);
    window.addEventListener("open-remove-dialog", handleOpenRemove);
    return () => {
      window.removeEventListener("open-merge-dialog", handleOpenMerge);
      window.removeEventListener("open-reject-dialog", handleOpenReject);
      window.removeEventListener("open-remove-dialog", handleOpenRemove);
    };
  }, []);

  const fetchDirty = useCallback(async () => {
    setDirty({ loading: true, hasUncommitted: false, files: [] });
    try {
      const resp = await fetch(`/api/agents/${agentId}/git-status`);
      const data = await resp.json();
      setDirty({ loading: false, hasUncommitted: data.hasUncommitted, files: data.files || [] });
    } catch {
      setDirty({ loading: false, hasUncommitted: false, files: [] });
    }
  }, [agentId]);

  function openConfirm(type: DialogType) {
    setOpenDialog(type);
    fetchDirty();
  }

  async function handleStop() {
    setActionLoading(true);
    try {
      await fetch(`/api/agents/${agentId}/stop`, { method: "POST" });
      window.location.reload();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleMerge() {
    setActionLoading(true);
    try {
      await fetch(`/api/agents/${agentId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "merge", cleanup: cleanupOnMerge, closeIssue: closeIssueOnMerge }),
      });
      if (cleanupOnMerge) {
        window.location.href = `/projects/${projectName}`;
      } else {
        window.location.reload();
      }
    } finally {
      setActionLoading(false);
    }
  }

  function toggleIgnore(file: string) {
    setIgnoreSelection((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });
  }

  async function handleGitignoreAndCommit() {
    if (ignoreSelection.size === 0) return;
    setActionLoading(true);
    try {
      // Extract pattern: "?? .10timesdev/" → ".10timesdev/", "M package-lock.json" → "package-lock.json"
      const patterns = [...ignoreSelection].map((f) => f.replace(/^.{1,2}\s+/, "").trim());
      const resp = await fetch(`/api/agents/${agentId}/gitignore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patterns }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        alert(`Gitignore failed: ${data.error || resp.statusText}`);
      } else {
        setIgnoreSelection(new Set());
      }
      fetchDirty();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDirectCommit() {
    if (!commitMsg.trim()) return;
    setActionLoading(true);
    try {
      const resp = await fetch(`/api/agents/${agentId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: commitMsg.trim() }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        alert(`Commit failed: ${data.error || resp.statusText}`);
      } else {
        setCommitMsg("");
      }
      fetchDirty();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCommitAndMerge() {
    setActionLoading(true);
    try {
      await fetch(`/api/agents/${agentId}/wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Commit all uncommitted changes now. Use a descriptive commit message. Then push to origin.",
        }),
      });
      setOpenDialog(null);
      window.location.reload();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReject() {
    setActionLoading(true);
    try {
      await fetch(`/api/agents/${agentId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", cleanup: cleanupOnReject, closeIssue: closeIssueOnReject }),
      });
      if (cleanupOnReject) {
        window.location.href = `/projects/${projectName}`;
      } else {
        window.location.reload();
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRemove() {
    setActionLoading(true);
    try {
      const qs = closeIssueOnRemove ? "" : "?closeIssue=false";
      await fetch(`/api/agents/${agentId}${qs}`, { method: "DELETE" });
      window.location.href = `/projects/${projectName}`;
    } finally {
      setActionLoading(false);
    }
  }

  function CleanupCheckbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
      <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded border-border"
        />
        {label}
      </label>
    );
  }

  // Buttons are now rendered by NextSteps (agent-state-panel.tsx).
  // This component only hosts the confirmation dialogs triggered via
  // window events: "open-merge-dialog", "open-reject-dialog".
  return (
    <>

      {/* ── Merge Dialog ── */}
      <Dialog open={openDialog === "merge"} onOpenChange={(o) => !o && setOpenDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5 text-green-500" />
              Merge to master
            </DialogTitle>
            <DialogDescription>
              Agent branch will be merged into <code className="bg-muted px-1 rounded">master</code> with{" "}
              <code className="bg-muted px-1 rounded">--no-ff</code> and pushed to origin.
            </DialogDescription>
          </DialogHeader>

          {dirty.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking for uncommitted changes...
            </div>
          ) : dirty.hasUncommitted ? (
            <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-yellow-600 dark:text-yellow-400">
                <AlertTriangle className="h-4 w-4" />
                Uncommitted changes detected
              </div>
              <p className="text-sm text-muted-foreground">
                Merge is not possible with uncommitted changes. You can send the agent a command to commit first.
              </p>
              <div className="max-h-32 overflow-auto text-xs font-mono bg-background rounded p-2 border space-y-0.5">
                {dirty.files.map((f, i) => (
                  <label key={i} className="flex items-center gap-2 text-muted-foreground cursor-pointer hover:text-foreground">
                    <input
                      type="checkbox"
                      checked={ignoreSelection.has(f)}
                      onChange={() => toggleIgnore(f)}
                      className="rounded"
                    />
                    {f}
                  </label>
                ))}
              </div>
              {ignoreSelection.size > 0 && (
                <Button size="sm" variant="outline" onClick={handleGitignoreAndCommit} disabled={actionLoading}>
                  {actionLoading ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Adding...</>
                  ) : (
                    `Add ${ignoreSelection.size} to .gitignore & commit`
                  )}
                </Button>
              )}
              <div className="flex gap-2 items-center pt-1">
                <input
                  type="text"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleDirectCommit()}
                  placeholder="Commit message..."
                  className="flex-1 text-xs bg-background border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button size="sm" onClick={handleDirectCommit} disabled={actionLoading || !commitMsg.trim()}>
                  {actionLoading ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Committing...</>
                  ) : (
                    "Commit & push"
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3">
              <p className="text-sm text-green-700 dark:text-green-400">
                Working directory is clean. Ready to merge.
              </p>
            </div>
          )}

          <CleanupCheckbox
            checked={closeIssueOnMerge}
            onChange={setCloseIssueOnMerge}
            label="Close Linear issue (mark as Done)"
          />
          <CleanupCheckbox
            checked={cleanupOnMerge}
            onChange={setCleanupOnMerge}
            label="Remove container, local clone and volumes after merge"
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenDialog(null)} disabled={actionLoading}>
              Cancel
            </Button>
            {dirty.hasUncommitted && !dirty.loading ? (
              <Button onClick={handleCommitAndMerge} disabled={actionLoading}>
                {actionLoading ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Sending...</>
                ) : (
                  "Ask agent to commit"
                )}
              </Button>
            ) : (
              <Button onClick={handleMerge} disabled={actionLoading || dirty.loading || dirty.hasUncommitted}>
                {actionLoading ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Merging...</>
                ) : (
                  <><GitMerge className="h-4 w-4 mr-1" /> Merge to master</>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reject Dialog ── */}
      <Dialog open={openDialog === "reject"} onOpenChange={(o) => !o && setOpenDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="h-5 w-5 text-red-500" />
              Reject changes
            </DialogTitle>
            <DialogDescription>
              The agent&apos;s work will <strong>not</strong> be merged.
              Status will be set to <code className="bg-muted px-1 rounded">CANCELLED</code> and
              the Linear issue marked accordingly.
            </DialogDescription>
          </DialogHeader>

          {dirty.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking for uncommitted changes...
            </div>
          ) : dirty.hasUncommitted ? (
            <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-yellow-600 dark:text-yellow-400">
                <AlertTriangle className="h-4 w-4" />
                Uncommitted changes will be lost
              </div>
              <p className="text-sm text-muted-foreground">
                There are uncommitted changes in the working directory. These changes will be discarded.
              </p>
              <div className="max-h-32 overflow-auto text-xs font-mono bg-background rounded p-2 border">
                {dirty.files.map((f, i) => (
                  <div key={i} className="text-muted-foreground">{f}</div>
                ))}
              </div>
            </div>
          ) : null}

          <CleanupCheckbox
            checked={closeIssueOnReject}
            onChange={setCloseIssueOnReject}
            label="Close Linear issue (mark as Cancelled)"
          />
          <CleanupCheckbox
            checked={cleanupOnReject}
            onChange={setCleanupOnReject}
            label="Remove container, local clone and volumes"
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenDialog(null)} disabled={actionLoading}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={actionLoading}>
              {actionLoading ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Rejecting...</>
              ) : (
                <><Ban className="h-4 w-4 mr-1" /> Reject changes</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Remove Dialog ── */}
      <Dialog open={openDialog === "remove"} onOpenChange={(o) => !o && setOpenDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-red-500" />
              Remove agent
            </DialogTitle>
            <DialogDescription>
              Removes the container, local clone, volumes, and remote branch.
            </DialogDescription>
          </DialogHeader>

          {dirty.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking for uncommitted changes...
            </div>
          ) : dirty.hasUncommitted ? (
            <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-yellow-600 dark:text-yellow-400">
                <AlertTriangle className="h-4 w-4" />
                Uncommitted changes will be lost
              </div>
              <p className="text-sm text-muted-foreground">
                There are uncommitted local changes that haven&apos;t been pushed.
                Only committed &amp; pushed code is recoverable from the remote branch.
              </p>
              <div className="max-h-32 overflow-auto text-xs font-mono bg-background rounded p-2 border">
                {dirty.files.map((f, i) => (
                  <div key={i} className="text-muted-foreground">{f}</div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-muted p-3">
              <p className="text-sm text-muted-foreground">
                No uncommitted changes. All work is safely on the remote branch.
              </p>
            </div>
          )}

          <CleanupCheckbox
            checked={closeIssueOnRemove}
            onChange={setCloseIssueOnRemove}
            label="Close Linear issue (mark as Cancelled)"
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenDialog(null)} disabled={actionLoading}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRemove} disabled={actionLoading}>
              {actionLoading ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Removing...</>
              ) : (
                <><Trash2 className="h-4 w-4 mr-1" /> Remove agent</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
