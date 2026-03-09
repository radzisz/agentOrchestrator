import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join, extname } from "path";
import * as store from "@/lib/store";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string; filename: string }> },
) {
  const { name, filename } = await params;
  const project = store.getProjectByName(name);
  if (!project) return new NextResponse("Not found", { status: 404 });

  // Sanitize filename to prevent path traversal
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe.includes("..")) return new NextResponse("Bad request", { status: 400 });

  const filePath = join(project.path, ".10timesdev", "tasks", safe);

  if (!existsSync(filePath)) return new NextResponse("Not found", { status: 404 });

  const ext = extname(safe).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const data = readFileSync(filePath);

  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
