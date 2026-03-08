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

  if (agg.snapshot.lifecycle !== "removed") {
    return NextResponse.json(
      { error: `Agent is not removed (lifecycle=${agg.snapshot.lifecycle})` },
      { status: 400 },
    );
  }

  // Set state synchronously BEFORE fire-and-forget so UI reflects immediately.
  // withLock runs on the next microtask so without this there's a race where
  // the UI still sees lifecycle=removed after the POST returns.
  agg.prepareRestore();

  // Fire and forget — the operation runs in the background via withLock
  agg.restoreAgent({ fromBranch, setInProgress: setInProgress ?? true }).catch(() => {});

  return NextResponse.json({ ok: true, agentId: agg.issueId });
}
