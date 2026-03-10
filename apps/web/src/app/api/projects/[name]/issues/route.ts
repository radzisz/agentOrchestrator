import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as db from "@/lib/db";
import { createLocalIssue } from "@/lib/issue-trackers/local-tracker";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const q = req.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const phase = req.nextUrl.searchParams.get("phase") || "";
  const source = req.nextUrl.searchParams.get("source") || "";

  const dbOpts: Parameters<typeof db.listIssues>[0] = {
    projectPath: project.path,
  };

  if (source) dbOpts.source = source;

  if (phase && phase !== "all") {
    if (phase === "open") {
      dbOpts.phase = ["todo", "in_progress", "in_review"];
    } else {
      dbOpts.phase = phase;
    }
  }

  let rows = db.listIssues(dbOpts);

  if (q) {
    rows = rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.identifier.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    );
  }

  const result = rows.map((r) => {
    const labels: string[] = JSON.parse(r.labels || "[]");
    const comments = db.getComments(r.id);
    return {
      id: r.id,
      identifier: r.identifier,
      title: r.title,
      description: r.description,
      phase: r.phase,
      labels,
      source: r.source,
      createdBy: r.created_by,
      createdAt: r.created_at || "",
      url: r.url,
      commentCount: comments.length,
    };
  });

  return NextResponse.json(result);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { title, description, labels } = body as {
    title?: string;
    description?: string;
    labels?: string[];
  };

  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const record = createLocalIssue(project.path, title.trim(), description?.trim(), labels);
  return NextResponse.json(record, { status: 201 });
}
