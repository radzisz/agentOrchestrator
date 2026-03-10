// ---------------------------------------------------------------------------
// SQLite database — single file at .config/orchestrator.db
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// Reuse workspace root detection from store.ts
function findWorkspaceRoot(): string {
  const fromCwd = process.cwd();
  const fromMonorepo = join(fromCwd, "..", "..");
  if (existsSync(join(fromCwd, "pnpm-workspace.yaml")) || existsSync(join(fromCwd, ".config"))) return fromCwd;
  if (existsSync(join(fromMonorepo, "pnpm-workspace.yaml")) || existsSync(join(fromMonorepo, ".config"))) return fromMonorepo;
  return fromCwd;
}

const CONFIG_DIR = join(findWorkspaceRoot(), ".config");
const DB_PATH = join(CONFIG_DIR, "orchestrator.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  migrate(_db);
  return _db;
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER DEFAULT 3,
      phase TEXT DEFAULT 'todo',
      raw_state TEXT,
      labels TEXT DEFAULT '[]',
      created_by TEXT,
      created_at TEXT,
      url TEXT,
      synced_at TEXT,
      UNIQUE(project_path, source, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_path);
    CREATE INDEX IF NOT EXISTS idx_issues_phase ON issues(project_path, phase);
    CREATE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);
    CREATE INDEX IF NOT EXISTS idx_issues_source ON issues(project_path, source);

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      author_name TEXT,
      is_bot INTEGER DEFAULT 0,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
  `);
}

// ---------------------------------------------------------------------------
// Issue CRUD
// ---------------------------------------------------------------------------

export interface DbIssue {
  id: string;
  project_path: string;
  source: string;
  external_id: string | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  phase: string;
  raw_state: string | null;
  labels: string; // JSON array
  created_by: string | null;
  created_at: string | null;
  url: string | null;
  synced_at: string | null;
}

export interface DbComment {
  id: string;
  issue_id: string;
  body: string;
  author_name: string | null;
  is_bot: number;
  created_at: string | null;
}

/** Insert or update an issue. Returns the issue id. */
export function upsertIssue(issue: Omit<DbIssue, "synced_at">): string {
  const db = getDb();
  db.prepare(`
    INSERT INTO issues (id, project_path, source, external_id, identifier, title, description, priority, phase, raw_state, labels, created_by, created_at, url, synced_at)
    VALUES (@id, @project_path, @source, @external_id, @identifier, @title, @description, @priority, @phase, @raw_state, @labels, @created_by, @created_at, @url, datetime('now'))
    ON CONFLICT(project_path, source, external_id) DO UPDATE SET
      identifier = @identifier,
      title = @title,
      description = @description,
      priority = @priority,
      phase = @phase,
      raw_state = @raw_state,
      labels = @labels,
      created_by = @created_by,
      url = @url,
      synced_at = datetime('now')
  `).run(issue);
  return issue.id;
}

/** Get issue by id. */
export function getIssue(id: string): DbIssue | null {
  return getDb().prepare("SELECT * FROM issues WHERE id = ?").get(id) as DbIssue | null;
}

/** Get issue by project + source + external_id. */
export function getIssueByExternal(projectPath: string, source: string, externalId: string): DbIssue | null {
  return getDb().prepare(
    "SELECT * FROM issues WHERE project_path = ? AND source = ? AND external_id = ?"
  ).get(projectPath, source, externalId) as DbIssue | null;
}

/** Get issue by identifier (e.g. "AGEN-3"). */
export function getIssueByIdentifier(projectPath: string, identifier: string): DbIssue | null {
  return getDb().prepare(
    "SELECT * FROM issues WHERE project_path = ? AND identifier = ?"
  ).get(projectPath, identifier) as DbIssue | null;
}

/** List issues for a project, optionally filtered. */
export function listIssues(opts: {
  projectPath?: string;
  source?: string;
  phase?: string | string[];
  label?: string;
  limit?: number;
  offset?: number;
}): DbIssue[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.projectPath) {
    conditions.push("project_path = ?");
    params.push(opts.projectPath);
  }
  if (opts.source) {
    conditions.push("source = ?");
    params.push(opts.source);
  }
  if (opts.phase) {
    if (Array.isArray(opts.phase)) {
      conditions.push(`phase IN (${opts.phase.map(() => "?").join(",")})`);
      params.push(...opts.phase);
    } else {
      conditions.push("phase = ?");
      params.push(opts.phase);
    }
  }
  if (opts.label) {
    conditions.push("labels LIKE ?");
    params.push(`%"${opts.label}"%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ? `LIMIT ${opts.limit}` : "";
  const offset = opts.offset ? `OFFSET ${opts.offset}` : "";

  return getDb().prepare(
    `SELECT * FROM issues ${where} ORDER BY created_at DESC ${limit} ${offset}`
  ).all(...params) as DbIssue[];
}

/** Update issue phase. */
export function updateIssuePhase(id: string, phase: string): void {
  getDb().prepare("UPDATE issues SET phase = ?, synced_at = datetime('now') WHERE id = ?").run(phase, id);
}

/** Update issue fields. */
export function updateIssue(id: string, updates: Partial<Pick<DbIssue, "title" | "description" | "phase" | "labels" | "raw_state">>): void {
  const sets: string[] = ["synced_at = datetime('now')"];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }

  params.push(id);
  getDb().prepare(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

/** Delete issue and its comments. */
export function deleteIssue(id: string): boolean {
  const result = getDb().prepare("DELETE FROM issues WHERE id = ?").run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Comment CRUD
// ---------------------------------------------------------------------------

/** Add a comment to an issue. */
export function addComment(issueId: string, body: string, authorName: string, isBot = false): string {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO comments (id, issue_id, body, author_name, is_bot, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(id, issueId, body, authorName, isBot ? 1 : 0);
  return id;
}

/** Get comments for an issue. */
export function getComments(issueId: string): DbComment[] {
  return getDb().prepare(
    "SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC"
  ).all(issueId) as DbComment[];
}

// ---------------------------------------------------------------------------
// Migration from local-issues.json
// ---------------------------------------------------------------------------

export function migrateLocalIssuesJson(projectPath: string, jsonPath: string): number {
  const { existsSync: exists, readFileSync, renameSync } = require("fs");
  if (!exists(jsonPath)) return 0;

  let records: Array<{
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    phase: string;
    labels: string[];
    createdAt: string;
    comments: Array<{ body: string; createdAt: string; authorName: string }>;
  }>;

  try {
    records = JSON.parse(readFileSync(jsonPath, "utf-8"));
  } catch {
    return 0;
  }

  if (!Array.isArray(records) || records.length === 0) return 0;

  const db = getDb();
  const insertIssue = db.prepare(`
    INSERT OR IGNORE INTO issues (id, project_path, source, external_id, identifier, title, description, priority, phase, raw_state, labels, created_by, created_at, url, synced_at)
    VALUES (?, ?, 'local', ?, ?, ?, ?, 3, ?, ?, ?, 'local', ?, NULL, datetime('now'))
  `);
  const insertComment = db.prepare(`
    INSERT INTO comments (id, issue_id, body, author_name, is_bot, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const migrate = db.transaction(() => {
    for (const r of records) {
      const result = insertIssue.run(
        r.id, projectPath, r.id, r.identifier,
        r.title, r.description, r.phase, r.phase,
        JSON.stringify(r.labels), r.createdAt
      );
      if (result.changes > 0) {
        count++;
        for (const c of r.comments || []) {
          insertComment.run(
            crypto.randomUUID(), r.id, c.body, c.authorName,
            c.authorName === "orchestrator" ? 1 : 0, c.createdAt
          );
        }
      }
    }
  });
  migrate();

  // Rename old file to .bak
  try { renameSync(jsonPath, jsonPath + ".migrated"); } catch {}

  return count;
}
