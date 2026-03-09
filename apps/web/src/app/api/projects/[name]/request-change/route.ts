import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { triggerSync } from "@/services/dispatcher";
import { getCreatableTrackers, getTracker } from "@/lib/issue-trackers/registry";
import { createLocalIssue } from "@/lib/issue-trackers/local-tracker";

/** GET — return list of trackers that can create issues for this project */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const trackers = getCreatableTrackers(project.path);
  return NextResponse.json(
    trackers.map((t) => ({ name: t.name, displayName: t.displayName })),
  );
}

/** POST — create an issue in the specified tracker */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = await req.json();
  const { title, description, tracker: trackerName } = body as {
    title: string;
    description?: string;
    tracker?: string;
  };

  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const selectedTracker = trackerName || "local";

  try {
    if (selectedTracker === "local") {
      return createInLocal(project.path, title.trim(), description?.trim());
    }

    // Use tracker abstraction for all non-local trackers
    const tracker = getTracker(selectedTracker);
    if (!tracker?.createIssue) {
      return NextResponse.json(
        { error: `Tracker "${selectedTracker}" does not support issue creation` },
        { status: 400 },
      );
    }

    const issue = await tracker.createIssue(title.trim(), description?.trim() || "", ["agent"], project.path);

    // Trigger dispatcher sync
    triggerSync().catch(() => {});

    return NextResponse.json({
      issueId: issue.identifier,
      issueUuid: issue.externalId,
      tracker: selectedTracker,
      message: `Created ${issue.identifier} — the dispatcher will pick it up automatically.`,
    });
  } catch (err) {
    console.error("[request-change] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function createInLocal(projectPath: string, title: string, description?: string) {
  const record = createLocalIssue(projectPath, title, description);

  // Trigger dispatcher sync so it picks up the new issue
  triggerSync().catch(() => {});

  return NextResponse.json({
    issueId: record.identifier,
    issueUuid: record.id,
    tracker: "local",
    message: `Created ${record.identifier} — the dispatcher will pick it up automatically.`,
  });
}
