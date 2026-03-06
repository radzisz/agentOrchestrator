import { NextRequest, NextResponse } from "next/server";
import { findAggregate } from "@/lib/agent-aggregate/find-agent";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json();
  const { fromBranch, setInProgress } = body;

  if (!fromBranch) {
    return NextResponse.json({ error: "fromBranch is required" }, { status: 400 });
  }

  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (agg.state.lifecycle !== "removed") {
    return NextResponse.json(
      { error: `Agent is not removed (lifecycle=${agg.state.lifecycle})` },
      { status: 400 },
    );
  }

  // Fire and forget — the operation runs in the background via withLock
  agg.restoreAgent({ fromBranch, setInProgress: setInProgress ?? true }).catch(() => {});

  return NextResponse.json({ ok: true, agentId: agg.issueId });
}
