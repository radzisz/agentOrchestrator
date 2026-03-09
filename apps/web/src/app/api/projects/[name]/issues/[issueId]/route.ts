import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import {
  getLocalIssue,
  updateLocalIssue,
  deleteLocalIssue,
} from "@/lib/issue-trackers/local-tracker";

type Params = { name: string; issueId: string };

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const { name, issueId } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const issue = getLocalIssue(project.path, issueId);
  if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

  return NextResponse.json(issue);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const { name, issueId } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const updated = updateLocalIssue(project.path, issueId, body);
  if (!updated) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<Params> },
) {
  const { name, issueId } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ok = deleteLocalIssue(project.path, issueId);
  if (!ok) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
