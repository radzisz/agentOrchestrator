import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import {
  listLocalIssues,
  createLocalIssue,
} from "@/lib/issue-trackers/local-tracker";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const q = req.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const phase = req.nextUrl.searchParams.get("phase") || "";

  let issues = listLocalIssues(project.path);

  if (phase && phase !== "all") {
    if (phase === "open") {
      issues = issues.filter((i) => !["done", "cancelled"].includes(i.phase));
    } else {
      issues = issues.filter((i) => i.phase === phase);
    }
  }

  if (q) {
    issues = issues.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.identifier.toLowerCase().includes(q) ||
        (i.description?.toLowerCase().includes(q) ?? false),
    );
  }

  // Newest first
  issues.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return NextResponse.json(issues);
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
