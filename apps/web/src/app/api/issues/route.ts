import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as db from "@/lib/db";

/** GET — all issues across all projects and trackers (local + Linear + Sentry etc.) */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const phase = req.nextUrl.searchParams.get("phase") || "";
  const projectFilter = req.nextUrl.searchParams.get("project") || "";
  const sourceFilter = req.nextUrl.searchParams.get("source") || "";

  const projects = store.listProjects();
  const projectsByPath = new Map(projects.map((p) => [p.path, p]));

  // Build DB query opts
  const dbOpts: Parameters<typeof db.listIssues>[0] = {};

  if (projectFilter) {
    const proj = projects.find((p) => p.name === projectFilter);
    if (proj) dbOpts.projectPath = proj.path;
    else return NextResponse.json([]);
  }

  if (sourceFilter) {
    dbOpts.source = sourceFilter;
  }

  if (phase && phase !== "all") {
    if (phase === "open") {
      dbOpts.phase = ["todo", "in_progress", "in_review"];
    } else {
      dbOpts.phase = phase;
    }
  }

  let rows = db.listIssues(dbOpts);

  // Text search filter (DB doesn't support full-text yet)
  if (q) {
    rows = rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.identifier.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    );
  }

  const result = rows.map((r) => {
    const proj = projectsByPath.get(r.project_path);
    const labels: string[] = JSON.parse(r.labels || "[]");
    const comments = db.getComments(r.id);
    return {
      projectName: proj?.name || "",
      projectPath: r.project_path,
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
