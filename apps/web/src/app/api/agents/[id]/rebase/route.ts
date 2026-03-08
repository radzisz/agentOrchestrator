import { NextRequest, NextResponse } from "next/server";
import { findAggregate } from "@/lib/agent-aggregate";
import * as cmd from "@/lib/cmd";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (agg.snapshot.git.op === "rebasing" || agg.currentOperation?.name === "rebase") {
    return NextResponse.json({ started: false, reason: "already rebasing" });
  }

  agg.rebase().catch((err) => {
    cmd.logError(`rebase:${agg.issueId}`, `Background crash: ${err}`);
  });

  return NextResponse.json({ started: true });
}
