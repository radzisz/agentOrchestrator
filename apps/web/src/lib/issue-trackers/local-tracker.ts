// ---------------------------------------------------------------------------
// Local issue tracker — stores issues in {projectPath}/.10timesdev/local-issues.json
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type {
  IssueTracker,
  TrackerIssue,
  TrackerComment,
  TrackerPhase,
  TrackerTypeSchema,
} from "./types";

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

interface LocalIssueRecord {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  phase: TrackerPhase;
  labels: string[];
  createdAt: string;
  comments: Array<{ body: string; createdAt: string; authorName: string }>;
}

function issuesFilePath(projectPath: string): string {
  return join(projectPath, ".10timesdev", "local-issues.json");
}

function readIssues(projectPath: string): LocalIssueRecord[] {
  const fp = issuesFilePath(projectPath);
  if (!existsSync(fp)) return [];
  try {
    return JSON.parse(readFileSync(fp, "utf-8"));
  } catch {
    return [];
  }
}

function writeIssues(projectPath: string, issues: LocalIssueRecord[]): void {
  const dir = join(projectPath, ".10timesdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(issuesFilePath(projectPath), JSON.stringify(issues, null, 2));
}

function nextIdentifier(projectPath: string, issues: LocalIssueRecord[]): string {
  // Derive prefix from project folder name
  const parts = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const folderName = parts[parts.length - 1] || "LOCAL";
  const prefix = folderName
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .slice(0, 4) || "LOC";

  const maxNum = issues.reduce((max, i) => {
    const m = i.identifier.match(new RegExp(`^${prefix}-(\\d+)$`));
    return m ? Math.max(max, parseInt(m[1])) : max;
  }, 0);

  return `${prefix}-${maxNum + 1}`;
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

export type { LocalIssueRecord };

export function listLocalIssues(projectPath: string): LocalIssueRecord[] {
  return readIssues(projectPath);
}

export function getLocalIssue(projectPath: string, id: string): LocalIssueRecord | null {
  return readIssues(projectPath).find((i) => i.id === id) ?? null;
}

export function createLocalIssue(
  projectPath: string,
  title: string,
  description?: string,
  labels?: string[],
): LocalIssueRecord {
  const issues = readIssues(projectPath);
  const record: LocalIssueRecord = {
    id: randomUUID(),
    identifier: nextIdentifier(projectPath, issues),
    title,
    description: description || null,
    phase: "todo",
    labels: labels ?? ["agent"],
    createdAt: new Date().toISOString(),
    comments: [],
  };
  issues.push(record);
  writeIssues(projectPath, issues);
  return record;
}

export function updateLocalIssue(
  projectPath: string,
  id: string,
  updates: Partial<Pick<LocalIssueRecord, "title" | "description" | "phase" | "labels">>,
): LocalIssueRecord | null {
  const issues = readIssues(projectPath);
  const idx = issues.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  if (updates.title !== undefined) issues[idx].title = updates.title;
  if (updates.description !== undefined) issues[idx].description = updates.description;
  if (updates.phase !== undefined) issues[idx].phase = updates.phase;
  if (updates.labels !== undefined) issues[idx].labels = updates.labels;
  writeIssues(projectPath, issues);
  return issues[idx];
}

export function deleteLocalIssue(projectPath: string, id: string): boolean {
  const issues = readIssues(projectPath);
  const idx = issues.findIndex((i) => i.id === id);
  if (idx < 0) return false;
  issues.splice(idx, 1);
  writeIssues(projectPath, issues);
  return true;
}

// ---------------------------------------------------------------------------
// Map to TrackerIssue
// ---------------------------------------------------------------------------

function toTrackerIssue(r: LocalIssueRecord): TrackerIssue {
  return {
    externalId: r.id,
    identifier: r.identifier,
    title: r.title,
    description: r.description,
    priority: 3,
    phase: r.phase,
    rawState: r.phase,
    labels: r.labels,
    createdBy: "local",
    createdAt: r.createdAt,
    url: null,
    source: "local",
    comments: r.comments.map((c) => ({
      body: c.body,
      createdAt: c.createdAt,
      authorName: c.authorName,
      isBot: false,
    })),
    _raw: r,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const localSchema: TrackerTypeSchema = {
  type: "local",
  displayName: "Local",
  fields: [], // No config needed
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
    const issues = readIssues(projectPath);
    // Return only open issues (todo / in_progress / in_review) with the agent label
    return issues
      .filter((i) => !["done", "cancelled"].includes(i.phase) && i.labels.includes("agent"))
      .map(toTrackerIssue);
  },

  async transitionTo(issue: TrackerIssue, phase: TrackerPhase, projectPath: string): Promise<void> {
    const issues = readIssues(projectPath);
    const idx = issues.findIndex((i) => i.id === issue.externalId);
    if (idx >= 0) {
      issues[idx].phase = phase;
      writeIssues(projectPath, issues);
    }
  },

  async addComment(issue: TrackerIssue, body: string, projectPath: string): Promise<void> {
    const issues = readIssues(projectPath);
    const idx = issues.findIndex((i) => i.id === issue.externalId);
    if (idx >= 0) {
      issues[idx].comments.push({
        body,
        createdAt: new Date().toISOString(),
        authorName: "orchestrator",
      });
      writeIssues(projectPath, issues);
    }
  },

  async getComments(issue: TrackerIssue, _projectPath: string): Promise<TrackerComment[]> {
    const raw = issue._raw as LocalIssueRecord;
    return (raw.comments || []).map((c) => ({
      body: c.body,
      createdAt: c.createdAt,
      authorName: c.authorName,
      isBot: c.authorName === "orchestrator",
    }));
  },

  hasLabel(issue: TrackerIssue, label: string): boolean {
    return issue.labels.includes(label);
  },

  async getIssue(externalId: string, projectPath: string): Promise<TrackerIssue | null> {
    const issues = readIssues(projectPath);
    const found = issues.find((i) => i.id === externalId);
    return found ? toTrackerIssue(found) : null;
  },
};
