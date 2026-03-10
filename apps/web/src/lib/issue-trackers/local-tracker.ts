// ---------------------------------------------------------------------------
// Local issue tracker — backed by SQLite (orchestrator.db)
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import * as db from "@/lib/db";
import type {
  IssueTracker,
  TrackerIssue,
  TrackerComment,
  TrackerPhase,
  TrackerTypeSchema,
} from "./types";

// ---------------------------------------------------------------------------
// Auto-migration: import legacy local-issues.json on first access per project
// ---------------------------------------------------------------------------

const _migrated = new Set<string>();

function ensureMigrated(projectPath: string): void {
  if (_migrated.has(projectPath)) return;
  _migrated.add(projectPath);
  const jsonPath = join(projectPath, ".10timesdev", "local-issues.json");
  if (existsSync(jsonPath)) {
    db.migrateLocalIssuesJson(projectPath, jsonPath);
  }
}

// ---------------------------------------------------------------------------
// Identifier generation
// ---------------------------------------------------------------------------

function nextIdentifier(projectPath: string): string {
  const parts = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const folderName = parts[parts.length - 1] || "LOCAL";
  const prefix = folderName
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .slice(0, 4) || "LOC";

  const existing = db.listIssues({ projectPath, source: "local" });
  const maxNum = existing.reduce((max, i) => {
    const m = i.identifier.match(new RegExp(`^${prefix}-(\\d+)$`));
    return m ? Math.max(max, parseInt(m[1])) : max;
  }, 0);

  return `${prefix}-${maxNum + 1}`;
}

// ---------------------------------------------------------------------------
// Legacy-compatible record type (for callers that still use it)
// ---------------------------------------------------------------------------

export interface LocalIssueRecord {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  phase: TrackerPhase;
  labels: string[];
  createdAt: string;
  comments: Array<{ body: string; createdAt: string; authorName: string }>;
}

function dbToRecord(row: db.DbIssue, projectPath: string): LocalIssueRecord {
  const comments = db.getComments(row.id);
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    phase: row.phase as TrackerPhase,
    labels: JSON.parse(row.labels || "[]"),
    createdAt: row.created_at || new Date().toISOString(),
    comments: comments.map((c) => ({
      body: c.body,
      createdAt: c.created_at || "",
      authorName: c.author_name || "unknown",
    })),
  };
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

export function listLocalIssues(projectPath: string): LocalIssueRecord[] {
  ensureMigrated(projectPath);
  const rows = db.listIssues({ projectPath, source: "local" });
  return rows.map((r) => dbToRecord(r, projectPath));
}

export function getLocalIssue(projectPath: string, id: string): LocalIssueRecord | null {
  ensureMigrated(projectPath);
  const row = db.getIssue(id);
  if (!row || row.source !== "local" || row.project_path !== projectPath) return null;
  return dbToRecord(row, projectPath);
}

export function createLocalIssue(
  projectPath: string,
  title: string,
  description?: string,
  labels?: string[],
): LocalIssueRecord {
  ensureMigrated(projectPath);
  const id = randomUUID();
  const identifier = nextIdentifier(projectPath);
  const now = new Date().toISOString();
  const issueLabels = labels ?? ["agent"];

  db.upsertIssue({
    id,
    project_path: projectPath,
    source: "local",
    external_id: id,
    identifier,
    title,
    description: description || null,
    priority: 3,
    phase: "todo",
    raw_state: "todo",
    labels: JSON.stringify(issueLabels),
    created_by: "local",
    created_at: now,
    url: null,
  });

  return {
    id,
    identifier,
    title,
    description: description || null,
    phase: "todo",
    labels: issueLabels,
    createdAt: now,
    comments: [],
  };
}

export function updateLocalIssue(
  projectPath: string,
  id: string,
  updates: Partial<Pick<LocalIssueRecord, "title" | "description" | "phase" | "labels">>,
): LocalIssueRecord | null {
  ensureMigrated(projectPath);
  const row = db.getIssue(id);
  if (!row || row.source !== "local" || row.project_path !== projectPath) return null;

  const dbUpdates: Parameters<typeof db.updateIssue>[1] = {};
  if (updates.title !== undefined) dbUpdates.title = updates.title;
  if (updates.description !== undefined) dbUpdates.description = updates.description;
  if (updates.phase !== undefined) { dbUpdates.phase = updates.phase; dbUpdates.raw_state = updates.phase; }
  if (updates.labels !== undefined) dbUpdates.labels = JSON.stringify(updates.labels);

  db.updateIssue(id, dbUpdates);
  return getLocalIssue(projectPath, id);
}

export function deleteLocalIssue(projectPath: string, id: string): boolean {
  ensureMigrated(projectPath);
  return db.deleteIssue(id);
}

// ---------------------------------------------------------------------------
// Map to TrackerIssue
// ---------------------------------------------------------------------------

function toTrackerIssue(row: db.DbIssue, projectPath: string): TrackerIssue {
  const comments = db.getComments(row.id);
  const labels: string[] = JSON.parse(row.labels || "[]");
  return {
    externalId: row.id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    priority: row.priority,
    phase: row.phase as TrackerPhase,
    rawState: row.raw_state || row.phase,
    labels,
    createdBy: row.created_by || "local",
    createdAt: row.created_at,
    url: row.url,
    source: "local",
    comments: comments.map((c) => ({
      body: c.body,
      createdAt: c.created_at || "",
      authorName: c.author_name || "unknown",
      isBot: c.is_bot === 1,
    })),
    _raw: row,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const localSchema: TrackerTypeSchema = {
  type: "local",
  displayName: "Local",
  fields: [],
};

// ---------------------------------------------------------------------------
// IssueTracker implementation
// ---------------------------------------------------------------------------

export const localTracker: IssueTracker = {
  name: "local",
  displayName: "Local",
  schema: localSchema,

  canTransitionState: true,
  canComment: true,
  canDetectWake: true,
  canManageLabels: true,
  canCreateIssue: true,

  async pollIssues(projectPath: string): Promise<TrackerIssue[]> {
    ensureMigrated(projectPath);
    const rows = db.listIssues({
      projectPath,
      source: "local",
      phase: ["todo", "in_progress", "in_review"],
      label: "agent",
    });
    return rows.map((r) => toTrackerIssue(r, projectPath));
  },

  async transitionTo(issue: TrackerIssue, phase: TrackerPhase): Promise<void> {
    db.updateIssuePhase(issue.externalId, phase);
  },

  async addComment(issue: TrackerIssue, body: string): Promise<void> {
    db.addComment(issue.externalId, body, "orchestrator", true);
  },

  async getComments(issue: TrackerIssue): Promise<TrackerComment[]> {
    const comments = db.getComments(issue.externalId);
    return comments.map((c) => ({
      body: c.body,
      createdAt: c.created_at || "",
      authorName: c.author_name || "unknown",
      isBot: c.is_bot === 1,
    }));
  },

  hasLabel(issue: TrackerIssue, label: string): boolean {
    return issue.labels.includes(label);
  },

  async getIssue(externalId: string, projectPath: string): Promise<TrackerIssue | null> {
    ensureMigrated(projectPath);
    const row = db.getIssue(externalId);
    if (!row) return null;
    return toTrackerIssue(row, projectPath);
  },
};
