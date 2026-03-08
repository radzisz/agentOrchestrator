import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { simpleGit } from "@/lib/cmd";
import * as store from "@/lib/store";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!existsSync(project.path)) {
    return NextResponse.json(
      { error: `Project directory does not exist: ${project.path}` },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { branch } = body as { branch: string };

  if (!branch) {
    return NextResponse.json({ error: "branch is required" }, { status: 400 });
  }

  try {
    const git = simpleGit(project.path);

    // Fetch latest from remote
    await git.fetch("origin");

    // Create local tracking branch
    await git.checkout(["-B", branch, `origin/${branch}`]);

    // Switch back to the default branch so the main repo isn't left on an agent branch
    let defaultBranch = "main";
    try {
      const head = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      defaultBranch = head.trim().replace("refs/remotes/origin/", "");
    } catch {
      // fallback
    }

    await git.checkout(defaultBranch);

    return NextResponse.json({ ok: true, branch });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to checkout: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
