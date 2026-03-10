"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Play, Trash2, Loader2, X } from "lucide-react";
import { extractImages, stripImages } from "@/lib/markdown-images";

interface TaskStatus {
  hash: string;
  issueId: string;
  identifier: string;
  title: string;
  submittedAt: string;
  phase: string;
  agentId: string | null;
  agentStatus: string | null;
}

const PHASE_COLORS: Record<string, string> = {
  todo: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  in_review: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  done: "bg-green-500/15 text-green-600 dark:text-green-400",
  cancelled: "bg-gray-500/15 text-gray-600 dark:text-gray-400",
};

const PHASE_LABELS: Record<string, string> = {
  todo: "Todo",
  in_progress: "Running",
  in_review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

// ---------------------------------------------------------------------------
// Parse content into sections
// ---------------------------------------------------------------------------

interface Section {
  type: "draft" | "ready" | "submitted";
  text: string;          // raw text (for draft/ready)
  title: string;         // first line
  body: string;          // rest
  startLine: number;
  endLine: number;       // inclusive (includes ___ for ready)
  identifier?: string;   // for submitted
  task?: TaskStatus;     // for submitted
}

const SEPARATOR_RE = /^_{3,}\s*$/;
const MARKER_RE = /^<!-- CDM:(\S+) -->$/;

function parseSections(content: string, taskMap: Map<string, TaskStatus>): Section[] {
  if (!content.trim()) return [];

  const lines = content.split("\n");
  const sections: Section[] = [];
  let blockStart = 0;

  for (let i = 0; i <= lines.length; i++) {
    const isEnd = i === lines.length;
    const isSep = !isEnd && SEPARATOR_RE.test(lines[i]);
    const isMarker = !isEnd && MARKER_RE.test(lines[i]);

    if (isMarker) {
      // Flush any draft text before marker
      if (i > blockStart) {
        const text = lines.slice(blockStart, i).join("\n").trim();
        if (text) {
          const textLines = text.split("\n");
          sections.push({
            type: "draft",
            text,
            title: textLines[0],
            body: textLines.slice(1).join("\n").trim(),
            startLine: blockStart,
            endLine: i - 1,
          });
        }
      }

      const match = lines[i].match(MARKER_RE)!;
      const identifier = match[1];
      const task = taskMap.get(identifier);
      sections.push({
        type: "submitted",
        text: lines[i],
        title: task?.title || identifier,
        body: "",
        startLine: i,
        endLine: i,
        identifier,
        task,
      });
      blockStart = i + 1;
      continue;
    }

    if (isSep || isEnd) {
      const text = lines.slice(blockStart, i).join("\n").trim();
      if (text) {
        const textLines = text.split("\n").filter((l) => l.trim());
        // All text blocks are "ready" — last block doesn't need trailing ___
        sections.push({
          type: "ready",
          text,
          title: textLines[0] || "",
          body: textLines.slice(1).join("\n").trim(),
          startLine: blockStart,
          endLine: isSep ? i : i - 1,
        });
      }
      blockStart = i + 1;
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// CdmTab
// ---------------------------------------------------------------------------

export function CdmTab({ projectName }: { projectName: string }) {
  const [content, setContent] = useState("");
  const [tasks, setTasks] = useState<TaskStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submittingIdx, setSubmittingIdx] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [hiddenPhases, setHiddenPhases] = useState<Set<string>>(new Set(["done", "cancelled"]));
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  // ---------------------------------------------------------------------------
  // Fetch tasks
  // ---------------------------------------------------------------------------

  const fetchTasks = useCallback(async () => {
    try {
      const resp = await fetch(`/api/projects/${projectName}/tasks`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (!loaded) {
        setContent(data.content || "");
        setLoaded(true);
      }
      setTasks(data.tasks || []);
    } catch {
      // ignore
    }
  }, [projectName, loaded]);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(() => {
      // Don't refresh content while user has unsaved edits
      const hasUnsavedEdits = saveTimerRef.current !== null;
      fetch(`/api/projects/${projectName}/tasks`)
        .then((r) => r.json())
        .then((data) => {
          setTasks(data.tasks || []);
          // Sync content from server unless user is actively editing
          if (!hasUnsavedEdits && data.content != null) {
            setContent(data.content);
          }
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [projectName, fetchTasks]);

  // ---------------------------------------------------------------------------
  // Auto-save (debounced)
  // ---------------------------------------------------------------------------

  const saveContent = useCallback(async (text: string) => {
    setSaving(true);
    try {
      await fetch(`/api/projects/${projectName}/tasks`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }, [projectName]);

  function handleChange(newContent: string) {
    setContent(newContent);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveContent(newContent), 1000);
  }

  // ---------------------------------------------------------------------------
  // Submit a single section
  // ---------------------------------------------------------------------------

  async function submitSection(sectionIdx: number) {
    setSubmittingIdx(sectionIdx);
    setLastResult(null);
    try {
      // Save first
      await saveContent(contentRef.current);

      // Compute which ready-block index this section is (only count "ready" sections)
      const allSections = parseSections(contentRef.current, taskMap);
      const readySections = allSections.filter((s) => s.type === "ready");
      const targetSection = allSections[sectionIdx];
      const blockIndex = targetSection ? readySections.indexOf(targetSection) : -1;

      const resp = await fetch(`/api/projects/${projectName}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(blockIndex >= 0 ? { blockIndex } : {}),
      });
      if (!resp.ok) {
        setLastResult("Failed to submit");
        return;
      }
      const result = await resp.json();
      // Refresh content + tasks
      const data = await fetch(`/api/projects/${projectName}/tasks`).then((r) => r.json());
      setContent(data.content || "");
      setTasks(data.tasks || []);

      if (result.submitted > 0) {
        setLastResult(`Started ${result.tasks?.join(", ") || result.submitted + " task(s)"}`);
      } else {
        setLastResult("No new tasks to submit");
      }
    } catch {
      setLastResult("Error submitting task");
    } finally {
      setSubmittingIdx(null);
      // Clear result message after a few seconds
      setTimeout(() => setLastResult(null), 5000);
    }
  }

  // ---------------------------------------------------------------------------
  // Image paste
  // ---------------------------------------------------------------------------

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;

      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;

      const formData = new FormData();
      formData.append("image", file);

      try {
        const resp = await fetch(`/api/projects/${projectName}/tasks/images`, {
          method: "POST",
          body: formData,
        });
        if (!resp.ok) continue;
        const { url } = await resp.json();

        const textarea = textareaRef.current;
        if (!textarea) continue;
        const pos = textarea.selectionStart;
        const before = content.slice(0, pos);
        const after = content.slice(pos);
        const imgMd = `![screenshot](${url})`;
        const newContent = before + imgMd + after;
        handleChange(newContent);

        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = pos + imgMd.length;
          textarea.focus();
        });
      } catch {
        // ignore
      }
      break;
    }
  }

  // ---------------------------------------------------------------------------
  // Delete task
  // ---------------------------------------------------------------------------

  async function deleteTask(task: TaskStatus) {
    try {
      await fetch(`/api/projects/${projectName}/tasks`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: task.identifier }),
      });
      const data = await fetch(`/api/projects/${projectName}/tasks`).then((r) => r.json());
      setContent(data.content || "");
      setTasks(data.tasks || []);
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Merge task
  // ---------------------------------------------------------------------------

  async function mergeTask(task: TaskStatus) {
    try {
      await fetch(`/api/agents/${task.identifier}/merge`, {
        method: "POST",
      });
      const data = await fetch(`/api/projects/${projectName}/tasks`).then((r) => r.json());
      setTasks(data.tasks || []);
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Collapse toggle
  // ---------------------------------------------------------------------------

  function toggleCollapse(idx: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const taskMap = new Map(tasks.map((t) => [t.identifier, t]));
  const sections = parseSections(content, taskMap);

  return (
    <div className="space-y-4">
      {/* Mode info */}
      <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground bg-muted/50 rounded-lg border border-border">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded font-medium">worktree</span>
        <span>Agents work in git worktrees (fast, shared .git)</span>
        <span className="text-border">|</span>
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-500/10 text-green-600 dark:text-green-400 rounded font-medium">auto-merge</span>
        <span>Done agents auto-rebase &amp; merge to main + cleanup</span>
      </div>

      {/* Editor */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          onPaste={handlePaste}
          placeholder={`Write tasks here. Use ___ to separate multiple tasks.\n\nFix the login button color\n\nThe button should be blue, not red.\n___\n\nAnother task here...`}
          className="w-full min-h-[120px] h-[50vh] p-4 font-mono text-sm bg-background border border-border rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          spellCheck={false}
        />
        <div className="absolute top-2 right-2 flex items-center gap-2">
          {saving && (
            <span className="text-xs text-muted-foreground">Saving...</span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Write tasks, use <code className="px-1 bg-muted rounded">___</code> to separate multiple tasks. Paste images with Ctrl+V.
        </p>
        {lastResult && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded ${
            lastResult.startsWith("Started") ? "bg-green-500/15 text-green-600 dark:text-green-400" :
            lastResult.startsWith("Error") || lastResult.startsWith("Failed") ? "bg-red-500/15 text-red-600 dark:text-red-400" :
            "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400"
          }`}>
            {lastResult}
          </span>
        )}
      </div>

      {/* Sections from editor (drafts + ready) */}
      {sections.filter((s) => s.type !== "submitted").length > 0 && (
        <div className="space-y-2">
          {sections.map((section, idx) => {
            if (section.type === "ready") {
              return (
                <ReadyCard
                  key={`r-${idx}`}
                  section={section}
                  isCollapsed={collapsed.has(idx)}
                  isSubmitting={submittingIdx === idx}
                  onToggle={() => toggleCollapse(idx)}
                  onStart={() => submitSection(idx)}
                />
              );
            }
            if (section.type === "draft" && section.text) {
              return (
                <DraftCard
                  key={`d-${idx}`}
                  section={section}
                  isCollapsed={collapsed.has(idx)}
                  onToggle={() => toggleCollapse(idx)}
                />
              );
            }
            return null;
          })}
        </div>
      )}

      {/* Submitted tasks */}
      {tasks.length > 0 && (() => {
        const filteredTasks = tasks.filter((t) => !hiddenPhases.has(t.phase));
        const hiddenCount = tasks.length - filteredTasks.length;
        const phases = ["todo", "in_progress", "in_review", "done", "cancelled"] as const;

        return (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground">Agents</h3>
              <div className="flex items-center gap-1">
                {phases.map((p) => {
                  const count = tasks.filter((t) => t.phase === p).length;
                  if (count === 0) return null;
                  const active = !hiddenPhases.has(p);
                  return (
                    <button
                      key={p}
                      onClick={() => setHiddenPhases((prev) => {
                        const next = new Set(prev);
                        if (next.has(p)) next.delete(p); else next.add(p);
                        return next;
                      })}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                        active
                          ? PHASE_COLORS[p]
                          : "bg-muted text-muted-foreground/50"
                      }`}
                      title={`${active ? "Hide" : "Show"} ${PHASE_LABELS[p]} (${count})`}
                    >
                      {PHASE_LABELS[p]} {count}
                    </button>
                  );
                })}
              </div>
            </div>
            {filteredTasks.map((task) => (
              <SubmittedCard
                key={task.identifier}
                task={task}
                projectName={projectName}
                isCollapsed={collapsed.has(1000 + tasks.indexOf(task))}
                onToggle={() => toggleCollapse(1000 + tasks.indexOf(task))}
                onDelete={deleteTask}
                onMerge={mergeTask}
              />
            ))}
            {filteredTasks.length === 0 && hiddenCount > 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">
                {hiddenCount} hidden — click filters above to show
              </p>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarkdownBody — renders text with image thumbnails inline
// ---------------------------------------------------------------------------

const IMG_RE = /!\[[^\]]*\]\([^)]+\)/g;

function MarkdownBody({ text }: { text: string }) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  const images = extractImages(text);
  const plainText = stripImages(text);

  return (
    <>
      {plainText && (
        <div className="text-xs text-muted-foreground font-mono whitespace-pre-wrap break-words">
          {plainText}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-1">
          {images.map((url, i) => (
            <button
              key={i}
              onClick={() => setLightbox(url)}
              className="shrink-0 rounded border border-border overflow-hidden hover:ring-2 hover:ring-ring transition-shadow"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="w-16 h-16 object-cover" />
            </button>
          ))}
        </div>
      )}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setLightbox(null)}
        >
          <button
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 text-white hover:text-gray-300"
          >
            <X className="w-6 h-6" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" className="max-w-[90vw] max-h-[90vh] rounded shadow-lg" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Draft Card — notes, not ready yet (no ___)
// ---------------------------------------------------------------------------

function DraftCard({
  section,
  isCollapsed,
  onToggle,
}: {
  section: Section;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const titleImages = extractImages(section.title);
  const plainTitle = stripImages(section.title) || stripImages(section.body) || "Untitled";
  const allText = [section.title, section.body].join("\n");
  const bodyImages = extractImages(allText);
  const bodyText = stripImages(section.body);
  const hasBody = bodyText || bodyImages.length > 0;

  return (
    <div className="border border-dashed border-border rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-muted/30 rounded-lg transition-colors"
      >
        <span className="shrink-0 mt-0.5">{isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}</span>
        <span className="text-xs text-muted-foreground shrink-0 mt-0.5">draft</span>
        <span className="text-sm break-words line-clamp-2 min-w-0">{plainTitle}</span>
        {titleImages.length > 0 && (
          <span className="text-xs text-muted-foreground shrink-0 mt-0.5">{titleImages.length} img</span>
        )}
      </button>
      {!isCollapsed && hasBody && (
        <div className="px-3 pb-2 pl-9 max-h-[200px] overflow-y-auto overflow-x-hidden">
          <MarkdownBody text={allText} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ready Card — has ___, can be started
// ---------------------------------------------------------------------------

function ReadyCard({
  section,
  isCollapsed,
  isSubmitting,
  onToggle,
  onStart,
}: {
  section: Section;
  isCollapsed: boolean;
  isSubmitting: boolean;
  onToggle: () => void;
  onStart: () => void;
}) {
  const plainTitle = stripImages(section.title) || stripImages(section.body) || "Untitled";
  const titleImages = extractImages(section.title);
  const allText = [section.title, section.body].join("\n");
  const bodyImages = extractImages(allText);
  const bodyText = stripImages(section.body);
  const hasBody = bodyText || bodyImages.length > 0;

  return (
    <div className="border border-border rounded-lg bg-muted/20 overflow-hidden">
      <div className="flex items-center justify-between overflow-hidden">
        <button
          onClick={onToggle}
          className="flex-1 flex items-start gap-2 px-3 py-2 text-left hover:bg-muted/30 rounded-l-lg transition-colors min-w-0"
        >
          <span className="shrink-0 mt-0.5">{isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}</span>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-orange-500/10 text-orange-600 dark:text-orange-400 rounded text-[11px] font-medium shrink-0">ready</span>
          <span className="text-sm break-words line-clamp-2 min-w-0">{plainTitle}</span>
          {titleImages.length > 0 && (
            <span className="text-xs text-muted-foreground shrink-0 mt-0.5">{titleImages.length} img</span>
          )}
        </button>
        <button
          onClick={onStart}
          disabled={isSubmitting}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-r-lg transition-colors shrink-0 disabled:opacity-70 ${
            isSubmitting
              ? "text-blue-500"
              : "text-green-600 dark:text-green-400 hover:bg-green-500/10"
          }`}
        >
          {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {isSubmitting ? "Starting..." : "Start"}
        </button>
      </div>
      {!isCollapsed && hasBody && (
        <div className="px-3 pb-2 pl-9 max-h-[200px] overflow-y-auto overflow-x-hidden">
          <MarkdownBody text={allText} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Submitted Card — task is running / done
// ---------------------------------------------------------------------------

function SubmittedCard({
  task,
  projectName,
  isCollapsed,
  onToggle,
  onDelete,
  onMerge,
}: {
  task: TaskStatus;
  projectName: string;
  isCollapsed: boolean;
  onToggle: () => void;
  onDelete: (task: TaskStatus) => void;
  onMerge: (task: TaskStatus) => void;
}) {
  const colorClass = PHASE_COLORS[task.phase] || PHASE_COLORS.todo;
  const phaseLabel = PHASE_LABELS[task.phase] || task.phase;
  const isDone = task.phase === "done" || task.phase === "cancelled";

  return (
    <div className={`border border-border rounded-lg overflow-hidden ${isDone ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between overflow-hidden">
        <button
          onClick={onToggle}
          className="flex-1 flex items-start gap-2 px-3 py-2 text-left hover:bg-muted/30 rounded-l-lg transition-colors min-w-0"
        >
          <span className="shrink-0 mt-0.5">{isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}</span>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0 ${colorClass}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              task.phase === "in_progress" ? "bg-blue-500 animate-pulse" :
              task.phase === "done" ? "bg-green-500" :
              task.phase === "in_review" ? "bg-purple-500" :
              task.phase === "cancelled" ? "bg-gray-500" : "bg-yellow-500"
            }`} />
            {phaseLabel}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">{task.identifier}</span>
          <span className="text-sm break-words line-clamp-2 min-w-0">{task.title}</span>
        </button>
        <div className="flex items-center gap-0.5 px-1 shrink-0">
          {task.agentId && (
            <Link
              href={`/projects/${projectName}/agents/${task.agentId}`}
              className="px-2 py-1 text-xs text-blue-500 hover:text-blue-400 hover:underline"
            >
              View
            </Link>
          )}
          {(task.phase === "in_review" || task.phase === "done") && task.agentId && (
            <button
              onClick={() => onMerge(task)}
              className="px-2 py-1 text-xs bg-green-500/15 text-green-600 dark:text-green-400 rounded hover:bg-green-500/25"
            >
              Merge
            </button>
          )}
          {!isDone && (
            <button
              onClick={() => onDelete(task)}
              className="p-1 text-muted-foreground hover:text-red-500 transition-colors"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {!isCollapsed && (
        <div className="px-3 pb-2 pl-9 text-xs text-muted-foreground">
          Submitted {new Date(task.submittedAt).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
    </div>
  );
}
