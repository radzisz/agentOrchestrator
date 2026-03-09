// ---------------------------------------------------------------------------
// Tracker contract — abstract base class for issue trackers
// ---------------------------------------------------------------------------

import type { ProviderTypeSchema } from "./config-schema";

export type TrackerPhase = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

export interface TrackerIssue {
  externalId: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  phase: TrackerPhase;
  rawState: string;
  labels: string[];
  createdBy: string | null;
  createdAt: string | null;
  url: string | null;
  source: string;
  comments: TrackerComment[];
  _raw: unknown;
}

export interface TrackerComment {
  body: string;
  createdAt: string;
  authorName: string;
  isBot: boolean;
}

export abstract class BaseTracker {
  abstract readonly name: string;
  abstract readonly schema: ProviderTypeSchema;

  readonly canTransitionState: boolean = false;
  readonly canComment: boolean = false;
  readonly canDetectWake: boolean = false;
  readonly canManageLabels: boolean = false;

  abstract pollIssues(config: Record<string, string>, projectPath: string): Promise<TrackerIssue[]>;

  async transitionTo?(config: Record<string, string>, issue: TrackerIssue, phase: TrackerPhase): Promise<void>;
  async addComment?(config: Record<string, string>, issue: TrackerIssue, body: string): Promise<void>;
  async getComments?(config: Record<string, string>, issue: TrackerIssue): Promise<TrackerComment[]>;
  hasLabel?(issue: TrackerIssue, label: string): boolean;
  async getIssue?(config: Record<string, string>, externalId: string): Promise<TrackerIssue | null>;
  async reassignOnDone?(config: Record<string, string>, issue: TrackerIssue): Promise<void>;
  async createIssue?(config: Record<string, string>, title: string, description: string, labels: string[]): Promise<{ externalId: string; identifier: string }>;
}
