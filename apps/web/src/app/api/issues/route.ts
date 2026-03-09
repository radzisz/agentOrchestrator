import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { listLocalIssues } from "@/lib/issue-trackers/local-tracker";

/** GET — all local issues across all projects */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const phase = req.nextUrl.searchParams.get("phase") || "";
  const projectFilter = req.nextUrl.searchParams.get("project") || "";

  const projects = store.listProjects();
  const result: Array<{
    projectName: string;
    projectPath: string;
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    phase: string;
    labels: string[];
    createdAt: string;
    commentCount: number;
  }> = [];

  for (const p of projects) {
    if (projectFilter && p.name !== projectFilter) continue;

    let issues = listLocalIssues(p.path);

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

    for (const i of issues) {
      result.push({
        projectName: p.name,
        projectPath: p.path,
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        description: i.description,
        phase: i.phase,
        labels: i.labels,
        createdAt: i.createdAt,
        commentCount: i.comments.length,
      });
    }
  }

  // Newest first
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return NextResponse.json(result);
}
