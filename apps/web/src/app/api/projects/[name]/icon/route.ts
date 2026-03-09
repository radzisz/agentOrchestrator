import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join, extname } from "path";
import * as store from "@/lib/store";

const SEARCH_PATHS = [
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/icon.tsx", // skip generated — can't serve
  "public/logo.svg",
  "public/logo.png",
  "public/logo.gif",
  "app/favicon.ico",
  "app/icon.svg",
  "app/icon.png",
  "favicon.ico",
  "favicon.svg",
];

// Also check monorepo patterns
const MONOREPO_PREFIXES = ["apps/web/", "packages/web/", "apps/frontend/"];

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const project = store.listProjects().find((p) => p.name === name);
  if (!project) {
    return new NextResponse(null, { status: 404 });
  }

  // Build full search list: direct paths + monorepo prefixed paths
  const allPaths = [...SEARCH_PATHS];
  for (const prefix of MONOREPO_PREFIXES) {
    for (const p of SEARCH_PATHS) {
      allPaths.push(prefix + p);
    }
  }

  for (const relPath of allPaths) {
    if (relPath.endsWith(".tsx")) continue; // skip React components
    const fullPath = join(project.path, relPath);
    if (existsSync(fullPath)) {
      try {
        const buf = readFileSync(fullPath);
        const ext = extname(relPath).toLowerCase();
        const contentType = MIME[ext] || "application/octet-stream";
        return new NextResponse(buf, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch {
        continue;
      }
    }
  }

  return new NextResponse(null, { status: 404 });
}
