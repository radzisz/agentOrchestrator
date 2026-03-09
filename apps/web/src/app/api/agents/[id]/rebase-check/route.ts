import { NextRequest, NextResponse } from "next/server";
import * as gitSvc from "@/services/git";
import { findAgentWithProject } from "@/lib/agent-aggregate/find-agent";

/**
 * Safety endpoint: checks if the repo is stuck in a rebase state.
 * If so, aborts the rebase to prevent broken state.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const found = findAgentWithProject(id);
  if (!found?.agent.agentDir) {
    return NextResponse.json({ ok: true });
  }

  const aborted = await gitSvc.abortRebaseIfStuck(found.agent.agentDir);
  if (aborted) {
    return NextResponse.json({ ok: false, wasStuck: true, aborted: true });
  }

  return NextResponse.json({ ok: true });
}
