import { NextRequest, NextResponse } from "next/server";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import { getBasePath } from "@/integrations/local-drive";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const scanPath = body.path || (await getBasePath());

  if (!scanPath) {
    return NextResponse.json(
      { error: "No scan path provided and no basePath configured in Local Drive integration" },
      { status: 400 },
    );
  }

  if (!existsSync(scanPath)) {
    return NextResponse.json(
      { error: `Directory does not exist: ${scanPath}` },
      { status: 400 },
    );
  }

  // Get already-registered project paths for filtering
  const existing = new Set(store.listProjects().map((p) => p.path.replace(/\\/g, "/")));

  const found: Array<{ name: string; path: string; alreadyAdded: boolean }> = [];

  try {
    const entries = readdirSync(scanPath);
    for (const entry of entries) {
      const fullPath = join(scanPath, entry);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
        const gitDir = join(fullPath, ".git");
        if (existsSync(gitDir)) {
          const normalized = fullPath.replace(/\\/g, "/");
          found.push({
            name: entry,
            path: normalized,
            alreadyAdded: existing.has(normalized),
          });
        }
      } catch {
        // skip entries we can't stat
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to read directory: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  found.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ path: scanPath, repos: found });
}
