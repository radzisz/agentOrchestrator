import { NextRequest, NextResponse } from "next/server";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import * as store from "@/lib/store";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const formData = await req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return NextResponse.json({ error: "No image provided" }, { status: 400 });

  // Determine extension from content type
  const contentType = file.type || "image/png";
  let ext = ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) ext = ".jpg";
  else if (contentType.includes("gif")) ext = ".gif";
  else if (contentType.includes("webp")) ext = ".webp";
  else if (contentType.includes("svg")) ext = ".svg";

  const filename = `img-${randomUUID().slice(0, 8)}${ext}`;
  const dir = join(project.path, ".10timesdev", "tasks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  writeFileSync(join(dir, filename), buffer);

  const url = `/api/projects/${name}/tasks/images/${filename}`;
  return NextResponse.json({ filename, url });
}
