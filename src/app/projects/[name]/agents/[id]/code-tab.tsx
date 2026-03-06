"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  Check,
  FileCode,
  FilePlus,
  FileX,
  GitBranch,
  GitCommit,
  GitMerge,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  RefreshCw,
  RotateCcw,
  Send,
  ChevronRight,
  X,
} from "lucide-react";

// --- Types ---

interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

interface ChangedFile {
  status: string;
  file: string;
  additions: number;
  deletions: number;
}

interface CodeData {
  branch: string;
  baseBranch: string;
  commits: CommitInfo[];
  changedFiles: ChangedFile[];
  summary: string;
  mainAhead?: number;
}

interface ReviewComment {
  file: string;
  selectedText: string;
  note: string;
}

const statusColors: Record<string, string> = {
  A: "text-green-500",
  M: "text-yellow-500",
  D: "text-red-500",
  R: "text-blue-500",
};

const statusLabels: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
};

function FileIcon({ status }: { status: string }) {
  const cls = `h-4 w-4 ${statusColors[status] || "text-muted-foreground"}`;
  if (status === "A") return <FilePlus className={cls} />;
  if (status === "D") return <FileX className={cls} />;
  return <FileCode className={cls} />;
}

// --- Custom scrollbar CSS ---

const SCROLLBAR_STYLE = `
.code-scroll::-webkit-scrollbar{width:8px;height:8px}
.code-scroll::-webkit-scrollbar-track{background:transparent}
.code-scroll::-webkit-scrollbar-thumb{background:rgba(128,128,128,.2);border-radius:4px}
.code-scroll::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.4)}
.code-scroll::-webkit-scrollbar-corner{background:transparent}
`;

// --- Syntax highlighting ---

const HL_KW = new Set([
  "abstract","as","async","await","break","case","catch","class","const","continue",
  "debugger","default","delete","do","else","enum","export","extends","false","finally",
  "for","from","function","get","if","implements","import","in","instanceof","interface",
  "let","new","null","of","package","private","protected","public","readonly","return",
  "set","static","super","switch","this","throw","true","try","type","typeof","undefined",
  "var","void","while","with","yield",
  "def","elif","except","lambda","pass","raise","None","True","False","and","or","not",
  "fn","impl","mod","pub","use","struct","trait","match","loop","mut","ref","self",
  "func","go","chan","defer","range","select","make",
]);

function highlightLine(code: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let pos = 0;
  let key = 0;
  while (pos < code.length) {
    const ch = code[pos];
    const rest = code.slice(pos);
    // String literals
    if (ch === '"' || ch === "'" || ch === "`") {
      let end = pos + 1;
      while (end < code.length && code[end] !== ch) {
        if (code[end] === "\\") end++;
        end++;
      }
      if (end < code.length) end++;
      const s = code.slice(pos, end);
      result.push(<span key={key++} className="text-emerald-400">{s}</span>);
      pos = end;
      continue;
    }
    // Line comment
    if (rest.startsWith("//")) {
      result.push(<span key={key++} className="text-muted-foreground/60 italic">{rest}</span>);
      pos = code.length;
      continue;
    }
    // Block comment
    if (rest.startsWith("/*")) {
      const ei = rest.indexOf("*/", 2);
      const s = ei >= 0 ? rest.slice(0, ei + 2) : rest;
      result.push(<span key={key++} className="text-muted-foreground/60 italic">{s}</span>);
      pos += s.length;
      continue;
    }
    // Numbers
    const nm = rest.match(/^\b\d+\.?\d*([eE][+-]?\d+)?\b/);
    if (nm) {
      result.push(<span key={key++} className="text-orange-300">{nm[0]}</span>);
      pos += nm[0].length;
      continue;
    }
    // Identifiers & keywords
    const im = rest.match(/^[a-zA-Z_$][\w$]*/);
    if (im) {
      const w = im[0];
      if (HL_KW.has(w)) {
        result.push(<span key={key++} className="text-purple-400">{w}</span>);
      } else if (/^[A-Z]/.test(w)) {
        result.push(<span key={key++} className="text-cyan-300">{w}</span>);
      } else {
        result.push(w);
      }
      pos += w.length;
      continue;
    }
    result.push(ch);
    pos++;
  }
  return result;
}

/** Highlight code within a diff line. keepPrefix=true keeps the +/-/space prefix unstyled. */
function hlContent(content: string, keepPrefix: boolean): React.ReactNode {
  if (!content || content.length <= 1) return content || " ";
  const code = content.slice(1);
  if (!code.trim()) return keepPrefix ? content : (code || " ");
  const tokens = highlightLine(code);
  return keepPrefix ? <>{content[0]}{tokens}</> : <>{tokens}</>;
}

// --- Diff minimap (change markers) ---

function DiffMinimap({
  lines,
  containerRef,
}: {
  lines: ParsedLine[];
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  if (lines.length < 10) return null;
  const regions: { start: number; end: number; type: "add" | "remove" }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].type;
    if (t !== "add" && t !== "remove") continue;
    const last = regions[regions.length - 1];
    if (last && last.type === t && last.end === i - 1) {
      last.end = i;
    } else {
      regions.push({ start: i, end: i, type: t });
    }
  }
  if (regions.length === 0) return null;
  const total = lines.length;
  function scrollTo(lineIdx: number) {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const lineH = el.scrollHeight / total;
    el.scrollTop = Math.max(0, lineIdx * lineH - el.clientHeight / 3);
  }
  return (
    <div className="w-3 shrink-0 relative bg-muted/10 border-l border-border/20">
      {regions.map((r, i) => {
        const top = (r.start / total) * 100;
        const height = ((r.end - r.start + 1) / total) * 100;
        return (
          <div
            key={i}
            className={`absolute left-0.5 right-0.5 rounded-[1px] cursor-pointer transition-opacity hover:opacity-60 ${
              r.type === "add" ? "bg-green-500/80" : "bg-red-500/80"
            }`}
            style={{ top: `${top}%`, height: `max(${height}%, 3px)` }}
            onClick={() => scrollTo(r.start)}
            title={`${r.type === "add" ? "+" : "−"} lines ${r.start + 1}–${r.end + 1}`}
          />
        );
      })}
    </div>
  );
}

// --- Format review as markdown ---

function formatReview(
  comments: ReviewComment[],
  generalComment: string
): string {
  const parts: string[] = ["## Code Review\n"];

  if (generalComment.trim()) {
    parts.push(generalComment.trim());
    parts.push("");
  }

  if (comments.length > 0) {
    parts.push("### Code comments\n");

    const byFile: Record<string, ReviewComment[]> = {};
    for (const c of comments) {
      if (!byFile[c.file]) byFile[c.file] = [];
      byFile[c.file].push(c);
    }

    for (const [file, fileComments] of Object.entries(byFile)) {
      parts.push(`**${file}**\n`);
      for (const c of fileComments) {
        const quoted = c.selectedText
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        parts.push(quoted);
        parts.push("");
        parts.push(c.note);
        parts.push("");
      }
    }
  }

  return parts.join("\n");
}

// --- Floating comment popover ---

function FloatingComment({
  position,
  onSave,
  onCancel,
}: {
  position: { x: number; y: number };
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (note.trim()) onSave(note.trim());
    }
  }

  return (
    <div
      className="fixed z-[100] bg-popover border rounded-lg shadow-xl p-2 w-72"
      style={{ left: position.x, top: position.y }}
    >
      <Textarea
        ref={ref}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add note... (Ctrl+Enter to save)"
        className="text-xs min-h-[60px] resize-none"
        rows={2}
      />
      <div className="flex gap-1.5 mt-1.5 justify-end">
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-6 text-xs px-2">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => note.trim() && onSave(note.trim())}
          disabled={!note.trim()}
          className="h-6 text-xs px-2"
        >
          Add
        </Button>
      </div>
    </div>
  );
}

// --- Diff mode types ---

type DiffMode = "unified" | "split" | "source" | "target";

const diffModeLabels: Record<DiffMode, string> = {
  unified: "Unified",
  split: "Split",
  source: "Source",
  target: "Target",
};

// --- Parsed diff line ---

interface ParsedLine {
  content: string;
  type: "add" | "remove" | "context" | "hunk" | "meta";
  oldLineNo: number | null;
  newLineNo: number | null;
}

function parseDiff(diff: string): ParsedLine[] {
  const raw = diff.split("\n");
  const result: ParsedLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw) {
    const hunkMatch = line.match(
      /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
    );
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      result.push({ content: line, type: "hunk", oldLineNo: null, newLineNo: null });
      continue;
    }

    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      result.push({ content: line, type: "meta", oldLineNo: null, newLineNo: null });
      continue;
    }

    if (line.startsWith("-")) {
      result.push({ content: line, type: "remove", oldLineNo: oldLine, newLineNo: null });
      oldLine++;
      continue;
    }

    if (line.startsWith("+")) {
      result.push({ content: line, type: "add", oldLineNo: null, newLineNo: newLine });
      newLine++;
      continue;
    }

    result.push({ content: line, type: "context", oldLineNo: oldLine, newLineNo: newLine });
    oldLine++;
    newLine++;
  }

  return result;
}

// For split view: pair up old/new lines side by side
interface SplitRow {
  left: ParsedLine | null;
  right: ParsedLine | null;
}

function buildSplitRows(parsed: ParsedLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;

  while (i < parsed.length) {
    const line = parsed[i];

    if (line.type === "meta" || line.type === "hunk") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }

    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }

    // Collect consecutive removes then adds to pair them
    if (line.type === "remove") {
      const removes: ParsedLine[] = [];
      while (i < parsed.length && parsed[i].type === "remove") {
        removes.push(parsed[i]);
        i++;
      }
      const adds: ParsedLine[] = [];
      while (i < parsed.length && parsed[i].type === "add") {
        adds.push(parsed[i]);
        i++;
      }

      const maxLen = Math.max(removes.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          left: j < removes.length ? removes[j] : null,
          right: j < adds.length ? adds[j] : null,
        });
      }
      continue;
    }

    if (line.type === "add") {
      rows.push({ left: null, right: line });
      i++;
      continue;
    }

    i++;
  }

  return rows;
}

// --- Selection-based comment hook ---

function useSelectionComment(
  containerRef: React.RefObject<HTMLElement | null>,
  file: string,
  onAddComment: (file: string, selectedText: string, note: string) => void
) {
  const [popover, setPopover] = useState<{
    x: number;
    y: number;
    selectedText: string;
  } | null>(null);

  function handleMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) return;
    const text = sel.toString().trim();
    if (!text || !containerRef.current.contains(sel.anchorNode)) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setPopover({
      x: Math.min(rect.left, window.innerWidth - 300),
      y: rect.bottom + 4,
      selectedText: text,
    });
  }

  function popoverElement() {
    if (!popover) return null;
    return (
      <FloatingComment
        position={{ x: popover.x, y: popover.y }}
        onSave={(note) => {
          onAddComment(file, popover.selectedText, note);
          setPopover(null);
          window.getSelection()?.removeAllRanges();
        }}
        onCancel={() => {
          setPopover(null);
          window.getSelection()?.removeAllRanges();
        }}
      />
    );
  }

  return { handleMouseUp, popoverElement };
}

// --- Line style helper ---

function lineClass(type: ParsedLine["type"]): string {
  switch (type) {
    case "add":
      return "bg-green-500/10 text-green-700 dark:text-green-400";
    case "remove":
      return "bg-red-500/10 text-red-700 dark:text-red-400";
    case "hunk":
      return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
    case "meta":
      return "text-muted-foreground";
    default:
      return "text-foreground/80";
  }
}

// --- DiffView ---

function DiffView({
  diff,
  file,
  comments,
  onAddComment,
  mode,
}: {
  diff: string;
  file: string;
  comments: ReviewComment[];
  onAddComment: (file: string, selectedText: string, note: string) => void;
  mode: DiffMode;
}) {
  const containerRef = useRef<HTMLElement>(null);
  const { handleMouseUp, popoverElement } = useSelectionComment(
    containerRef,
    file,
    onAddComment
  );

  if (!diff || diff === "No changes") {
    return (
      <p className="p-3 text-sm text-muted-foreground">No changes</p>
    );
  }

  const parsed = parseDiff(diff).filter((l) => l.type !== "meta" && l.type !== "hunk");

  if (mode === "unified") {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_STYLE }} />
        <div className="flex h-full">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <pre
            ref={containerRef as any}
            className="text-xs font-mono overflow-x-auto overflow-y-auto select-text flex-1 code-scroll"
            onMouseUp={handleMouseUp}
          >
            {parsed.map((line, i) => (
              <div key={i} className={`px-3 py-0.5 flex ${lineClass(line.type)}`}>
                <span className="w-8 shrink-0 text-right pr-2 text-muted-foreground/30 select-none">
                  {line.oldLineNo ?? ""}
                </span>
                <span className="w-8 shrink-0 text-right pr-2 text-muted-foreground/30 select-none">
                  {line.newLineNo ?? ""}
                </span>
                <span className="whitespace-pre-wrap break-all">{hlContent(line.content, true)}</span>
              </div>
            ))}
          </pre>
          <DiffMinimap lines={parsed} containerRef={containerRef as React.RefObject<HTMLElement | null>} />
        </div>
        {popoverElement()}
      </>
    );
  }

  if (mode === "split") {
    const rows = buildSplitRows(parsed);
    return (
      <>
        <div className="flex h-full">
          <div
            ref={containerRef as any} // eslint-disable-line
            className="text-xs font-mono overflow-x-auto overflow-y-auto select-text flex-1 code-scroll"
            onMouseUp={handleMouseUp}
          >
            {rows.map((row, i) => {
              if (
                row.left &&
                row.right &&
                row.left === row.right &&
                (row.left.type === "hunk" || row.left.type === "meta")
              ) {
                return (
                  <div key={i} className={`px-3 py-0.5 ${lineClass(row.left.type)}`}>
                    <span className="whitespace-pre-wrap break-all">{row.left.content || " "}</span>
                  </div>
                );
              }

              return (
                <div key={i} className="flex">
                  <div
                    className={`w-1/2 flex px-2 py-0.5 border-r border-border/30 overflow-hidden ${
                      row.left
                        ? row.left.type === "remove"
                          ? "bg-red-500/10 text-red-700 dark:text-red-400"
                          : "text-foreground/80"
                        : "bg-muted/20"
                    }`}
                  >
                    <span className="w-8 shrink-0 text-right pr-2 text-muted-foreground/30 select-none">
                      {row.left?.oldLineNo ?? ""}
                    </span>
                    <span className="whitespace-pre-wrap break-all">
                      {row.left ? hlContent(row.left.content, true) : " "}
                    </span>
                  </div>
                  <div
                    className={`w-1/2 flex px-2 py-0.5 overflow-hidden ${
                      row.right
                        ? row.right.type === "add"
                          ? "bg-green-500/10 text-green-700 dark:text-green-400"
                          : "text-foreground/80"
                        : "bg-muted/20"
                    }`}
                  >
                    <span className="w-8 shrink-0 text-right pr-2 text-muted-foreground/30 select-none">
                      {row.right?.newLineNo ?? ""}
                    </span>
                    <span className="whitespace-pre-wrap break-all">
                      {row.right ? hlContent(row.right.content, true) : " "}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <DiffMinimap lines={parsed} containerRef={containerRef as React.RefObject<HTMLElement | null>} />
        </div>
        {popoverElement()}
      </>
    );
  }

  // source or target — show only one side
  const isSource = mode === "source";
  const filtered = parsed.filter((l) => {
    if (l.type === "meta" || l.type === "hunk") return true;
    if (l.type === "context") return true;
    if (isSource) return l.type === "remove";
    return l.type === "add";
  });

  return (
    <>
      <div className="flex h-full">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <pre
          ref={containerRef as any}
          className="text-xs font-mono overflow-x-auto overflow-y-auto select-text flex-1 code-scroll"
          onMouseUp={handleMouseUp}
        >
          {filtered.map((line, i) => (
            <div key={i} className={`px-3 py-0.5 flex ${lineClass(line.type)}`}>
              <span className="w-8 shrink-0 text-right pr-2 text-muted-foreground/30 select-none">
                {(isSource ? line.oldLineNo : line.newLineNo) ?? ""}
              </span>
              <span className="whitespace-pre-wrap break-all">
                {line.type === "context" ? hlContent(line.content, true) : hlContent(line.content, false)}
              </span>
            </div>
          ))}
        </pre>
        <DiffMinimap lines={filtered} containerRef={containerRef as React.RefObject<HTMLElement | null>} />
      </div>
      {popoverElement()}
    </>
  );
}

// --- Main CodeTab ---

export function CodeTab({
  projectName,
  issueId,
}: {
  projectName: string;
  issueId: string;
}) {
  const [data, setData] = useState<CodeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [fullDiffs, setFullDiffs] = useState<Record<string, string>>({});
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);

  // Commit filter state
  const [allCommits, setAllCommits] = useState<CommitInfo[]>([]);
  const [selectedCommits, setSelectedCommits] = useState<Set<string>>(new Set());
  const [filteredFiles, setFilteredFiles] = useState<ChangedFile[] | null>(null);
  const [filteredSummary, setFilteredSummary] = useState<string>("");

  // Diff view mode — persist user preference
  const [diffMode, setDiffMode] = useState<DiffMode>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("code-review-diff-mode");
      if (saved && saved in diffModeLabels) return saved as DiffMode;
    }
    return "unified";
  });

  const [fullFile, setFullFile] = useState(false);

  function changeDiffMode(mode: DiffMode) {
    setDiffMode(mode);
    localStorage.setItem("code-review-diff-mode", mode);
  }

  function toggleFullFile() {
    const newFull = !fullFile;
    setFullFile(newFull);
  }

  // Reviewed files tracking
  const storageKey = `code-review-${projectName}-${issueId}`;

  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(() => {
    try {
      const saved = sessionStorage.getItem(`${storageKey}-reviewed`);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });

  // Fullscreen mode
  const [fullscreen, setFullscreen] = useState(false);
  const [commitsOpen, setCommitsOpen] = useState(true);

  function toggleFullscreen() {
    setFullscreen((v) => {
      const next = !v;
      if (next) setCommitsOpen(false);
      else setCommitsOpen(true);
      return next;
    });
  }

  // Rebase state
  const [rebaseState, setRebaseState] = useState<
    "idle" | "rebasing" | "resolving" | "done" | "error"
  >("idle");
  const [rebaseError, setRebaseError] = useState("");
  const [rebaseSteps, setRebaseSteps] = useState<{ cmd: string; ok: boolean; output: string; ms: number }[]>([]);

  async function requestRebase() {
    setRebaseState("rebasing");
    setRebaseError("");
    setRebaseSteps([]);
    try {
      const resp = await fetch(`/api/agents/${issueId}/rebase`, {
        method: "POST",
      });
      const result = await resp.json();

      if (result.started || result.started === false) {
        pollRebaseResult();
        return;
      }

      setRebaseState("error");
      setRebaseError(result.error || "Rebase failed");
    } catch {
      setRebaseState("error");
      setRebaseError("Request failed");
    }
  }

  async function pollRebaseResult() {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const resp = await fetch(`/api/agents/${issueId}`);
        if (!resp.ok) continue;
        const data = await resp.json();
        const agent = data.agent;
        const result = agent.rebaseResult;

        // Update steps live
        if (result?.steps) {
          setRebaseSteps(result.steps);
        }

        // Still rebasing — keep polling
        if (agent.status === "REBASING") continue;

        // Status changed from REBASING → rebase is done.
        // Determine outcome from the result.
        if (!result || result.success) {
          // No result (instant) or explicit success
          setRebaseState("done");
          setTimeout(() => { setRebaseSteps([]); }, 5000);
          fetchData();
          return;
        }

        // All steps passed = success (finish() may not have saved yet)
        const allStepsOk = result.steps?.length > 0 && result.steps.every((s: { ok: boolean }) => s.ok);
        if (allStepsOk) {
          setRebaseState("done");
          setTimeout(() => { setRebaseSteps([]); }, 5000);
          fetchData();
          return;
        }

        if (result.conflict) {
          setRebaseState("resolving");
          pollAgentUntilDone();
          return;
        }

        // Explicit error
        if (result.error) {
          setRebaseState("error");
          setRebaseError(result.error);
          return;
        }

        // Fallback: some steps failed but no explicit error — show as done with warnings
        setRebaseState("done");
        fetchData();
        return;
      } catch {
        // retry
      }
    }
    setRebaseState("error");
    setRebaseError("Rebase timed out");
  }

  async function pollAgentUntilDone() {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const resp = await fetch(`/api/agents/${issueId}`);
        if (resp.ok) {
          const data = await resp.json();
          if (data.agent.status !== "RUNNING") {
            await fetch(`/api/agents/${issueId}/rebase-check`, { method: "POST" });
            setRebaseState("done");
            fetchData();
            return;
          }
        }
      } catch {
        // retry
      }
    }
    setRebaseState("done");
    fetchData();
  }

  // Review state
  const [comments, setComments] = useState<ReviewComment[]>(() => {
    try {
      const saved = sessionStorage.getItem(`${storageKey}-comments`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [generalComment, setGeneralComment] = useState(() => {
    try { return sessionStorage.getItem(`${storageKey}-general`) || ""; }
    catch { return ""; }
  });
  const [submitting, setSubmitting] = useState(false);
  const [reviewSent, setReviewSent] = useState(false);

  const canSend = comments.length > 0 || generalComment.trim().length > 0;
  const reviewBarRef = useRef<HTMLDivElement>(null);

  // Persist review state to sessionStorage
  useEffect(() => {
    try { sessionStorage.setItem(`${storageKey}-reviewed`, JSON.stringify([...reviewedFiles])); } catch {}
  }, [reviewedFiles, storageKey]);
  useEffect(() => {
    try { sessionStorage.setItem(`${storageKey}-comments`, JSON.stringify(comments)); } catch {}
  }, [comments, storageKey]);
  useEffect(() => {
    try { sessionStorage.setItem(`${storageKey}-general`, generalComment); } catch {}
  }, [generalComment, storageKey]);

  // Are all commits selected? (= show full diff, no filter)
  const allSelected =
    allCommits.length > 0 && selectedCommits.size === allCommits.length;

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(
        `/api/projects/${projectName}/agents/${issueId}/code?prefetch=1`
      );
      if (!resp.ok) {
        const body = await resp.json();
        if (body.error === "container_not_running") {
          setError("Container is not running. Starting...");
          // Start the container
          await fetch(`/api/agents/${issueId}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
          // Retry after a few seconds
          setTimeout(() => fetchData(), 5000);
          return;
        }
        setError(body.error || "Failed to load");
        return;
      }
      const d = await resp.json();
      setData(d as CodeData);
      setAllCommits(d.commits);
      setSelectedCommits(new Set(d.commits.map((c: CommitInfo) => c.hash)));
      setFilteredFiles(null);
      // Load prefetched diffs into cache
      if (d.diffs) {
        setDiffs(d.diffs);
        setFullDiffs(d.fullDiffs || {});
      }
      // Auto-open first file (no fetch needed if prefetched)
      if (d.changedFiles.length > 0 && !selectedFile) {
        setSelectedFile(d.changedFiles[0].file);
      }
    } catch {
      setError("Failed to fetch code changes");
    } finally {
      setLoading(false);
    }
  }, [projectName, issueId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Escape key closes fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [fullscreen]);

  // When commit selection changes (and not all selected), refetch filtered file list
  const fetchFiltered = useCallback(async (commits: Set<string>) => {
    const commitsParam = Array.from(commits).join(",");
    try {
      const resp = await fetch(
        `/api/projects/${projectName}/agents/${issueId}/code?commits=${encodeURIComponent(commitsParam)}`
      );
      if (resp.ok) {
        const d: CodeData = await resp.json();
        setFilteredFiles(d.changedFiles);
        setFilteredSummary(d.summary);
      }
    } catch {
      // ignore
    }
    // Clear cached diffs — they're for the old commit selection
    setDiffs({});
    setFullDiffs({});
    setSelectedFile(null);
  }, [projectName, issueId]);

  function toggleCommit(hash: string) {
    setSelectedCommits((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        if (next.size === 1) return prev; // don't allow empty
        next.delete(hash);
      } else {
        next.add(hash);
      }

      // If all selected again, go back to unfiltered
      if (next.size === allCommits.length) {
        setFilteredFiles(null);
        setDiffs({});
        setFullDiffs({});
        setSelectedFile(null);
      } else {
        fetchFiltered(next);
      }

      return next;
    });
  }

  function selectAllCommits() {
    setSelectedCommits(new Set(allCommits.map((c) => c.hash)));
    setFilteredFiles(null);
    setDiffs({});
    setFullDiffs({});
    setSelectedFile(null);
  }

  // Which file list to show
  const changedFiles = filteredFiles ?? data?.changedFiles ?? [];
  const summary = filteredFiles !== null ? filteredSummary : data?.summary ?? "";

  async function selectFile(file: string) {
    if (selectedFile === file && (diffs[file] || fullDiffs[file])) return;
    setSelectedFile(file);
    // Already in cache from prefetch
    if (diffs[file] || fullDiffs[file]) return;

    // Fallback: fetch on demand (e.g. after commit filter change)
    setLoadingDiff(file);
    try {
      const [compactResp, fullResp] = await Promise.all([
        fetch(`/api/projects/${projectName}/agents/${issueId}/code?file=${encodeURIComponent(file)}${!allSelected ? `&commits=${encodeURIComponent(Array.from(selectedCommits).join(","))}` : ""}`),
        fetch(`/api/projects/${projectName}/agents/${issueId}/code?file=${encodeURIComponent(file)}&full=1${!allSelected ? `&commits=${encodeURIComponent(Array.from(selectedCommits).join(","))}` : ""}`),
      ]);
      if (compactResp.ok) {
        const body = await compactResp.json();
        setDiffs((prev) => ({ ...prev, [file]: body.diff }));
      }
      if (fullResp.ok) {
        const body = await fullResp.json();
        setFullDiffs((prev) => ({ ...prev, [file]: body.diff }));
      }
    } catch {
      setDiffs((prev) => ({ ...prev, [file]: "Failed to load diff" }));
    } finally {
      setLoadingDiff(null);
    }
  }

  function handleAddComment(file: string, selectedText: string, note: string) {
    setComments((prev) => [...prev, { file, selectedText, note }]);
    setReviewSent(false);
  }

  function handleRemoveComment(index: number) {
    setComments((prev) => prev.filter((_, i) => i !== index));
  }

  async function submitReview() {
    if (!canSend || submitting) return;
    setSubmitting(true);
    try {
      const message = formatReview(comments, generalComment);
      const resp = await fetch(`/api/agents/${issueId}/wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!resp.ok) throw new Error("Failed to send review");
      setComments([]);
      setGeneralComment("");
      setReviewedFiles(new Set());
      setReviewSent(true);
      try {
        sessionStorage.removeItem(`${storageKey}-reviewed`);
        sessionStorage.removeItem(`${storageKey}-comments`);
        sessionStorage.removeItem(`${storageKey}-general`);
      } catch {}
    } catch {
      // Keep state so user can retry
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading changes...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-destructive mb-2">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchData}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const { branch, baseBranch } = data;

  const fileComments = selectedFile
    ? comments.filter((c) => c.file === selectedFile)
    : [];

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-[200] bg-background flex flex-col p-4 overflow-hidden"
          : "flex flex-col h-full"
      }
    >
      {/* Header */}
      <div className="flex items-center px-1 pb-2 gap-2 text-sm text-muted-foreground">
        <span className="font-mono">{baseBranch}</span>
        <span>→</span>
        <span className="font-mono font-medium text-foreground">{branch}</span>
        {summary && <span className="text-xs truncate">({summary})</span>}
        <button onClick={fetchData} className="text-muted-foreground hover:text-foreground transition-colors" title="Refresh">
          <RefreshCw className="h-3 w-3" />
        </button>
        {fullscreen && (
          <button
            onClick={toggleFullscreen}
            className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
            title="Close fullscreen"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Commits with checkboxes */}
      {allCommits.length > 0 && (
        <div className="px-1 pb-2">
          <button
            onClick={() => setCommitsOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${commitsOpen ? "rotate-90" : ""}`} />
            <GitCommit className="h-3 w-3" />
            <span>Commits ({allCommits.length})</span>
            {!allSelected && (
              <span className="text-[10px] text-muted-foreground/70 ml-1">
                {selectedCommits.size} selected
              </span>
            )}
          </button>
          {commitsOpen && (
            <>
              {!allSelected && (
                <div className="flex items-center gap-2 mt-1 ml-5">
                  <button
                    onClick={selectAllCommits}
                    className="text-[10px] text-blue-500 hover:text-blue-400"
                  >
                    select all
                  </button>
                </div>
              )}
              <div className="space-y-0.5 mt-1">
                {allCommits.map((c) => (
                  <label
                    key={c.hash}
                    className="flex items-center gap-2 text-xs py-0.5 px-1 rounded hover:bg-muted/50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedCommits.has(c.hash)}
                      onChange={() => toggleCommit(c.hash)}
                      className="rounded border-muted-foreground/30 h-3 w-3"
                    />
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {c.hash.slice(0, 7)}
                    </span>
                    <span className="truncate">{c.message}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0 ml-auto">
                      {c.author}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {allCommits.length === 0 && changedFiles.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No changes compared to {baseBranch}
        </p>
      )}

      {/* Main ahead warning */}
      {data.mainAhead != null && data.mainAhead > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 mb-2">
          <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0" />
          <div className="flex-1 text-xs">
            <span className="font-medium text-yellow-700 dark:text-yellow-400">
              {baseBranch} is {data.mainAhead} commit{data.mainAhead !== 1 ? "s" : ""} ahead
            </span>
            <span className="text-muted-foreground ml-1">
              — diff may contain changes from main. Rebase will resolve divergence and potential conflicts.
            </span>
          </div>
          {rebaseState === "done" ? (
            <span className="text-xs text-green-500 font-medium shrink-0 flex items-center gap-1">
              <Check className="h-3 w-3" />
              Done
            </span>
          ) : rebaseState === "rebasing" ? (
            <span className="text-xs text-blue-500 font-medium shrink-0 flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Rebasing...
            </span>
          ) : rebaseState === "resolving" ? (
            <span className="text-xs text-orange-500 font-medium shrink-0 flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Agent resolving conflicts...
            </span>
          ) : rebaseState === "error" ? (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-destructive">{rebaseError}</span>
              <Button size="sm" variant="outline" onClick={requestRebase} className="h-6 text-xs px-2">
                Retry
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={requestRebase}
              className="shrink-0 h-7 text-xs"
            >
              <GitBranch className="h-3 w-3 mr-1" />
              Rebase
            </Button>
          )}
        </div>
      )}

      {/* Rebase operation log — takes over main area while active */}
      {rebaseSteps.length > 0 && (
        <div className="border rounded-lg overflow-hidden mb-2 bg-black text-green-400 font-mono text-xs">
          <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-700">
            <span className="text-zinc-400 font-sans text-xs font-medium flex items-center gap-2">
              {rebaseState === "rebasing" && <Loader2 className="h-3 w-3 animate-spin text-yellow-400" />}
              {rebaseState === "done" && <Check className="h-3 w-3 text-green-400" />}
              {rebaseState === "error" && <X className="h-3 w-3 text-red-400" />}
              Rebase {issueId}
            </span>
            {rebaseState !== "rebasing" && (
              <button
                onClick={() => setRebaseSteps([])}
                className="text-zinc-500 hover:text-zinc-300 font-sans text-xs"
              >
                Close
              </button>
            )}
          </div>
          <div className="p-3 max-h-80 overflow-y-auto space-y-1">
            {rebaseSteps.map((s, i) => (
              <div key={i} className="flex gap-2">
                <span className={s.ok ? "text-green-400" : "text-red-400"}>
                  {s.ok ? "\u2713" : "\u2717"}
                </span>
                <span className="text-zinc-500 w-16 text-right shrink-0">
                  {s.ms > 0 ? `${s.ms}ms` : ""}
                </span>
                <span className="text-yellow-300 shrink-0">{s.cmd}</span>
                {s.output && (
                  <span className="text-zinc-500 truncate" title={s.output}>
                    {s.output.split("\n")[0]}
                  </span>
                )}
              </div>
            ))}
            {rebaseState === "rebasing" && (
              <div className="flex gap-2 animate-pulse">
                <span className="text-yellow-400">{">"}</span>
                <span className="text-zinc-400">running...</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Split layout: file list left, diff right */}
      {changedFiles.length > 0 && (
        <div className="flex flex-1 min-h-0 border rounded-lg overflow-hidden">
          {/* Left: file list split into to-review / reviewed */}
          <div className="w-64 shrink-0 border-r overflow-y-auto bg-muted/30 code-scroll">
            {(() => {
              const toReview = changedFiles.filter((f) => !reviewedFiles.has(f.file));
              const reviewed = changedFiles.filter((f) => reviewedFiles.has(f.file));

              function renderFile(f: ChangedFile) {
                const isActive = selectedFile === f.file;
                const isReviewed = reviewedFiles.has(f.file);
                const fileCommentCount = comments.filter(
                  (c) => c.file === f.file
                ).length;
                return (
                  <div
                    key={f.file}
                    className={`flex items-center gap-1 px-2 py-1.5 text-xs border-b border-border/50 ${
                      isActive ? "bg-muted" : "hover:bg-muted/50"
                    }`}
                  >
                    <button
                      className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                      onClick={() => selectFile(f.file)}
                    >
                      <FileIcon status={f.status} />
                      <span className="font-mono truncate flex-1" title={f.file}>
                        {f.file.split("/").pop()}
                      </span>
                      {fileCommentCount > 0 && (
                        <Badge variant="secondary" className="text-[9px] h-4 px-1">
                          {fileCommentCount}
                        </Badge>
                      )}
                      <span className="text-[10px] shrink-0 tabular-nums">
                        {f.additions > 0 && (
                          <span className="text-green-500">+{f.additions}</span>
                        )}
                        {f.deletions > 0 && (
                          <span className="text-red-500 ml-0.5">-{f.deletions}</span>
                        )}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setReviewedFiles((prev) => {
                          const next = new Set(prev);
                          if (isReviewed) next.delete(f.file);
                          else next.add(f.file);
                          return next;
                        });
                      }}
                      className={`shrink-0 p-0.5 rounded transition-colors ${
                        isReviewed
                          ? "text-green-500 hover:text-muted-foreground"
                          : "text-muted-foreground/30 hover:text-green-500"
                      }`}
                      title={isReviewed ? "Mark as unreviewed" : "Mark as reviewed"}
                    >
                      {isReviewed ? (
                        <RotateCcw className="h-3 w-3" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                );
              }

              return (
                <>
                  <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider bg-muted/50 sticky top-0 z-10">
                    To review ({toReview.length})
                  </div>
                  {toReview.length > 0
                    ? toReview.map(renderFile)
                    : <div className="px-3 py-4 text-xs text-muted-foreground/50 text-center">All files reviewed</div>
                  }
                  <div className="px-2 py-1 text-[10px] font-medium text-green-600 uppercase tracking-wider bg-green-500/5 sticky top-0 z-10">
                    Reviewed ({reviewed.length})
                  </div>
                  {reviewed.map(renderFile)}
                </>
              );
            })()}
          </div>

          {/* Right: diff view */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {!selectedFile && (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Select a file to view diff
              </div>
            )}

            {selectedFile && loadingDiff === selectedFile && (
              <div className="flex-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading diff...
              </div>
            )}

            {selectedFile && loadingDiff !== selectedFile && (
              <>
                {/* File path header + mode switcher */}
                <div className="px-3 py-1.5 border-b bg-muted/20 flex items-center gap-2 shrink-0">
                  <span className="text-xs font-mono text-muted-foreground truncate flex-1">
                    {selectedFile}
                  </span>
                  <button
                    onClick={toggleFullFile}
                    className={`px-2 py-0.5 text-[10px] rounded border transition-colors shrink-0 ${
                      fullFile
                        ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                        : "text-muted-foreground border-border hover:text-foreground"
                    }`}
                    title={fullFile ? "Show only changed regions" : "Show full file with changes highlighted"}
                  >
                    Full file
                  </button>
                  <div className="flex gap-0.5 bg-muted rounded-md p-0.5 shrink-0">
                    {(Object.keys(diffModeLabels) as DiffMode[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => changeDiffMode(m)}
                        className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                          diffMode === m
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {diffModeLabels[m]}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => toggleFullscreen()}
                    className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                  >
                    {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                  </button>
                </div>

                {/* Diff */}
                <div className="flex-1 overflow-auto code-scroll">
                  <DiffView
                    diff={(fullFile ? fullDiffs[selectedFile] : diffs[selectedFile]) || ""}
                    file={selectedFile}
                    comments={comments}
                    onAddComment={handleAddComment}
                    mode={diffMode}
                  />
                </div>

                {/* Inline comments for this file */}
                {fileComments.length > 0 && (
                  <div className="border-t bg-yellow-500/5 max-h-40 overflow-y-auto shrink-0">
                    {fileComments.map((c) => {
                      const globalIdx = comments.indexOf(c);
                      return (
                        <div
                          key={globalIdx}
                          className="px-3 py-1.5 border-b border-yellow-500/10 flex items-start gap-2 text-xs"
                        >
                          <MessageSquare className="h-3 w-3 text-yellow-600 shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <pre className="text-[10px] text-muted-foreground font-mono truncate">
                              {c.selectedText.split("\n")[0]}
                            </pre>
                            <p className="text-foreground/90 mt-0.5">{c.note}</p>
                          </div>
                          <button
                            onClick={() => handleRemoveComment(globalIdx)}
                            className="text-muted-foreground hover:text-destructive shrink-0"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* Review bar — bottom of right panel */}
            <div ref={reviewBarRef} className="border-t bg-muted/30 px-3 py-2 shrink-0">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Textarea
                    value={generalComment}
                    onChange={(e) => {
                      setGeneralComment(e.target.value);
                      setReviewSent(false);
                    }}
                    placeholder="General feedback — not tied to specific code"
                    className="text-sm min-h-[36px] max-h-[80px] resize-y"
                    rows={1}
                  />
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {comments.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                      {comments.length} note{comments.length !== 1 ? "s" : ""}
                    </Badge>
                  )}
                  {reviewSent && (
                    <span className="text-[10px] text-green-500 font-medium">Sent!</span>
                  )}
                  <Button
                    onClick={submitReview}
                    disabled={!canSend || submitting}
                    size="sm"
                    className="h-7 text-xs px-2.5"
                  >
                    {submitting ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <Send className="h-3 w-3 mr-1" />
                    )}
                    Send
                  </Button>
                  <button
                    onClick={() => toggleFullscreen()}
                    className="text-muted-foreground hover:text-foreground transition-colors p-1"
                    title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                  >
                    {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}


      {/* Floating action buttons */}
      {changedFiles.length > 0 && (() => {
        const allReviewed = changedFiles.length > 0 && changedFiles.every((f) => reviewedFiles.has(f.file));
        const hasFileToReview = selectedFile && !reviewedFiles.has(selectedFile);

        // Still reviewing files — show "Mark as reviewed"
        if (hasFileToReview) {
          return (
            <button
              onClick={() => {
                const toReview = changedFiles
                  .filter((f) => !reviewedFiles.has(f.file) && f.file !== selectedFile);
                setReviewedFiles((prev) => {
                  const next = new Set(prev);
                  next.add(selectedFile);
                  return next;
                });
                if (toReview.length > 0) {
                  selectFile(toReview[0].file);
                } else {
                  setSelectedFile(null);
                }
              }}
              className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-primary text-primary-foreground rounded-full px-4 py-2.5 shadow-lg hover:opacity-90 transition-opacity"
            >
              <Check className="h-4 w-4" />
              <span className="text-sm font-medium">Mark as reviewed</span>
            </button>
          );
        }

        // All files reviewed — show final action buttons
        if (allReviewed) {
          return (
            <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2">
              {comments.length > 0 ? (
                <>
                  <button
                    onClick={() => {
                      reviewBarRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                      reviewBarRef.current?.querySelector("textarea")?.focus();
                    }}
                    className="flex items-center gap-2 bg-muted text-foreground rounded-full px-4 py-2.5 shadow-lg hover:opacity-90 transition-opacity border"
                  >
                    <MessageSquare className="h-4 w-4" />
                    <span className="text-sm font-medium">Add general comment</span>
                  </button>
                  <button
                    onClick={submitReview}
                    disabled={submitting}
                    className="flex items-center gap-2 bg-primary text-primary-foreground rounded-full px-4 py-2.5 shadow-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    <span className="text-sm font-medium">Send {comments.length} note{comments.length !== 1 ? "s" : ""} to agent</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      reviewBarRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                      reviewBarRef.current?.querySelector("textarea")?.focus();
                    }}
                    className="flex items-center gap-2 bg-muted text-foreground rounded-full px-4 py-2.5 shadow-lg hover:opacity-90 transition-opacity border"
                  >
                    <MessageSquare className="h-4 w-4" />
                    <span className="text-sm font-medium">Add general comment</span>
                  </button>
                  <button
                    onClick={() => {
                      window.dispatchEvent(new Event("open-merge-dialog"));
                    }}
                    className="flex items-center gap-2 bg-green-600 text-white rounded-full px-4 py-2.5 shadow-lg hover:opacity-90 transition-opacity"
                  >
                    <GitMerge className="h-4 w-4" />
                    <span className="text-sm font-medium">Is OK — merge</span>
                  </button>
                </>
              )}
            </div>
          );
        }

        return null;
      })()}
    </div>
  );
}
