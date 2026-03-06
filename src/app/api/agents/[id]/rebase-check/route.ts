import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { join } from "path";
import { simpleGit } from "@/lib/cmd";
import * as store from "@/lib/store";

/**
 * Safety endpoint: checks if the repo is stuck in a rebase state.
 * If so, aborts the rebase to prevent broken state.
 * Works directly on host filesystem (no Docker needed).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const projects = store.listProjects();
  let agent: store.AgentData | null = null;
  for (const project of projects) {
    const a = store.getAgent(project.path, id);
    if (a) { agent = a; break; }
  }

  if (!agent?.agentDir) {
    return NextResponse.json({ ok: true });
  }

  const rebaseMerge = join(agent.agentDir, ".git", "rebase-merge");
  const rebaseApply = join(agent.agentDir, ".git", "rebase-apply");

  if (existsSync(rebaseMerge) || existsSync(rebaseApply)) {
    try {
      await simpleGit(agent.agentDir).rebase(["--abort"]);
      return NextResponse.json({ ok: false, wasStuck: true, aborted: true });
    } catch {
      return NextResponse.json({ ok: false, wasStuck: true, aborted: false });
    }
  }

  return NextResponse.json({ ok: true });
}
