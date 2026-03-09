import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import * as store from "@/lib/store";
import { createLocalIssue, listLocalIssues, deleteLocalIssue } from "@/lib/issue-trackers/local-tracker";
import { triggerSync } from "@/services/dispatcher";
import { tryGetAggregate } from "@/lib/agent-aggregate";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function tasksDir(projectPath: string): string {
  return join(projectPath, ".10timesdev", "tasks");
}

function tasksMdPath(projectPath: string): string {
  return join(tasksDir(projectPath), "tasks.md");
}

function metaPath(projectPath: string): string {
  return join(tasksDir(projectPath), "cdm-meta.json");
}

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

interface CdmMeta {
  hash: string;
  issueId: string;
  identifier: string;
  title: string;
  submittedAt: string;
}

function readMeta(projectPath: string): CdmMeta[] {
  const fp = metaPath(projectPath);
  if (!existsSync(fp)) return [];
  try {
    return JSON.parse(readFileSync(fp, "utf-8"));
  } catch {
    return [];
  }
}

function writeMeta(projectPath: string, meta: CdmMeta[]): void {
  const dir = tasksDir(projectPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(projectPath), JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Task status enrichment
// ---------------------------------------------------------------------------

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

function enrichMeta(projectPath: string, projectName: string, meta: CdmMeta[]): TaskStatus[] {
  const issues = listLocalIssues(projectPath);
  const issueMap = new Map(issues.map((i) => [i.id, i]));

  return meta.map((m) => {
    const issue = issueMap.get(m.issueId);
    let phase = issue?.phase || "todo";

    // Use cached aggregate state (updated by onExit callbacks + monitor).
    // No refreshAgent() here — that does Docker exec per agent and is too slow for a list endpoint.
    const agg = tryGetAggregate(projectName, m.identifier);
    const storedAgent = store.getAgent(projectPath, m.identifier);
    const agentId = agg || storedAgent ? m.identifier : null;
    const agentStatus = agg ? agg.uiStatus.status : (storedAgent?.uiStatus?.status || storedAgent?.status || null);

    // Override phase from agent's actual UI status for consistency
    // Local tracker phase can be stale (e.g. still "in_progress" when agent already stopped)
    if (agentStatus) {
      if (agentStatus === "running" || agentStatus === "starting") phase = "in_progress";
      else if (agentStatus === "awaiting") phase = "in_review";
      else if (agentStatus === "closed") phase = issue?.phase === "cancelled" ? "cancelled" : "done";
    }

    return {
      ...m,
      phase,
      agentId,
      agentStatus,
    };
  });
}

// ---------------------------------------------------------------------------
// GET — return tasks.md content + enriched task statuses
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const mdFile = tasksMdPath(project.path);
  const content = existsSync(mdFile) ? readFileSync(mdFile, "utf-8") : "";
  const meta = readMeta(project.path);
  const tasks = enrichMeta(project.path, name, meta);

  return NextResponse.json({ content, tasks });
}

// ---------------------------------------------------------------------------
// PUT — save tasks.md content
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { content } = body;
  if (typeof content !== "string") {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const dir = tasksDir(project.path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(tasksMdPath(project.path), content, "utf-8");

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST — submit: parse blocks ending with ___, create local issues
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DELETE — remove a submitted task by identifier
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { identifier } = await req.json();
  if (!identifier) return NextResponse.json({ error: "identifier required" }, { status: 400 });

  const meta = readMeta(project.path);
  const entry = meta.find((m) => m.identifier === identifier);
  if (!entry) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  // Delete the local issue
  deleteLocalIssue(project.path, entry.issueId);

  // Remove from meta
  const newMeta = meta.filter((m) => m.identifier !== identifier);
  writeMeta(project.path, newMeta);

  return NextResponse.json({ ok: true });
}

const SEPARATOR = /^_{3,}\s*$/m;
const MARKER_RE = /^<!-- CDM:(\S+) -->$/gm;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const targetBlockIndex: number | undefined = body.blockIndex;

  const mdFile = tasksMdPath(project.path);
  let content = existsSync(mdFile) ? readFileSync(mdFile, "utf-8") : "";

  if (!content.trim()) {
    return NextResponse.json({ error: "No content" }, { status: 400 });
  }

  const meta = readMeta(project.path);
  const existingHashes = new Set(meta.map((m) => m.hash));

  // Split by separator lines — last block doesn't need trailing ___
  const lines = content.split("\n");
  const blocks: { start: number; end: number; text: string }[] = [];
  let blockStart = 0;

  for (let i = 0; i < lines.length; i++) {
    if (SEPARATOR.test(lines[i])) {
      const blockText = lines.slice(blockStart, i).join("\n").trim();
      if (blockText && !blockText.match(MARKER_RE)) {
        blocks.push({ start: blockStart, end: i, text: blockText });
      }
      blockStart = i + 1;
    }
  }

  // Trailing block (no ___) is also submittable
  if (blockStart < lines.length) {
    const blockText = lines.slice(blockStart).join("\n").trim();
    if (blockText && !blockText.match(MARKER_RE)) {
      blocks.push({ start: blockStart, end: lines.length - 1, text: blockText });
    }
  }

  if (blocks.length === 0) {
    return NextResponse.json({ submitted: 0 });
  }

  // If blockIndex specified, only submit that one block
  const toProcess = targetBlockIndex !== undefined
    ? blocks.filter((_, i) => i === targetBlockIndex)
    : blocks;

  if (toProcess.length === 0) {
    return NextResponse.json({ submitted: 0 });
  }

  const newMeta: CdmMeta[] = [];

  // Process in reverse order so line indices stay valid
  const sorted = [...toProcess].sort((a, b) => b.start - a.start);
  for (const block of sorted) {
    const hash = createHash("sha256").update(block.text).digest("hex").slice(0, 16);

    if (existingHashes.has(hash)) continue;

    // First non-empty line is title, rest is description
    const blockLines = block.text.split("\n").filter((l) => l.trim());
    const title = blockLines[0] || "Untitled task";
    const description = blockLines.slice(1).join("\n").trim() || undefined;

    const record = createLocalIssue(project.path, title, description, ["agent"]);

    const entry: CdmMeta = {
      hash,
      issueId: record.id,
      identifier: record.identifier,
      title: record.title,
      submittedAt: new Date().toISOString(),
    };
    newMeta.push(entry);

    // Remove block + separator from editor
    lines.splice(block.start, block.end - block.start + 1);
  }

  // Save updated content
  content = lines.join("\n");
  const dir = tasksDir(project.path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(tasksMdPath(project.path), content, "utf-8");

  // Save meta
  meta.push(...newMeta);
  writeMeta(project.path, meta);

  // Trigger dispatcher to pick up new issues
  triggerSync().catch(() => {});

  return NextResponse.json({ submitted: newMeta.length, tasks: newMeta.map((m) => m.identifier) });
}
