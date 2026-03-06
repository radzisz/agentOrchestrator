import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  store.invalidateCache(project.path);
  return NextResponse.json({ ok: true });
}
