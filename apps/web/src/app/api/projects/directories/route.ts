import { NextRequest, NextResponse } from "next/server";
import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { getBasePath } from "@/integrations/local-drive";
import * as store from "@/lib/store";

interface DirEntry {
  name: string;        // display name (e.g. "myproject" or "ovaKids/extension")
  path: string;        // full path to git root (used as project path)
  projectDir: string;  // top-level project folder name
  hasGit: boolean;
  gitSubPath: string | null;  // relative sub-path where .git lives (null = root)
  alreadyAdded: boolean;
}

/** List immediate subdirectories that are not hidden. */
function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const basePath = await getBasePath();

  if (!existsSync(basePath)) {
    return NextResponse.json({ basePath, directories: [] });
  }

  const existing = new Set(store.listProjects().map((p) => p.path.replace(/\\/g, "/")));

  const results: DirEntry[] = [];
  const topDirs = listSubdirs(basePath);

  for (const dirName of topDirs) {
    const topPath = join(basePath, dirName);
    const topPathNorm = topPath.replace(/\\/g, "/");
    const hasGitRoot = existsSync(join(topPath, ".git"));

    if (hasGitRoot) {
      results.push({
        name: dirName,
        path: topPathNorm,
        projectDir: dirName,
        hasGit: true,
        gitSubPath: null,
        alreadyAdded: existing.has(topPathNorm),
      });
    } else {
      // Scan 2 levels deep for .git
      let foundGitInSub = false;
      const level1 = listSubdirs(topPath);

      for (const sub1 of level1) {
        const sub1Path = join(topPath, sub1);
        const sub1PathNorm = sub1Path.replace(/\\/g, "/");

        if (existsSync(join(sub1Path, ".git"))) {
          foundGitInSub = true;
          results.push({
            name: `${dirName}/${sub1}`,
            path: sub1PathNorm,
            projectDir: dirName,
            hasGit: true,
            gitSubPath: sub1,
            alreadyAdded: existing.has(sub1PathNorm),
          });
          continue;
        }

        // Level 2
        const level2 = listSubdirs(sub1Path);
        for (const sub2 of level2) {
          const sub2Path = join(sub1Path, sub2);
          const sub2PathNorm = sub2Path.replace(/\\/g, "/");

          if (existsSync(join(sub2Path, ".git"))) {
            foundGitInSub = true;
            results.push({
              name: `${dirName}/${sub1}/${sub2}`,
              path: sub2PathNorm,
              projectDir: dirName,
              hasGit: true,
              gitSubPath: `${sub1}/${sub2}`,
              alreadyAdded: existing.has(sub2PathNorm),
            });
          }
        }
      }

      // Also include the top-level dir itself (no git)
      if (!foundGitInSub) {
        results.push({
          name: dirName,
          path: topPathNorm,
          projectDir: dirName,
          hasGit: false,
          gitSubPath: null,
          alreadyAdded: existing.has(topPathNorm),
        });
      }
    }
  }

  // Sort: not added first, then alphabetical
  results.sort((a, b) => {
    if (a.alreadyAdded !== b.alreadyAdded) return a.alreadyAdded ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json({ basePath, directories: results });
}
