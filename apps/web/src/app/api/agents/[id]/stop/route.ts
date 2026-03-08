import { NextRequest, NextResponse } from "next/server";
import { findAggregate } from "@/lib/agent-aggregate";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Fire-and-forget — stop runs in background, UI polls transition state
  // (stopAgent sets transition internally via beginTransition("stopped"))
  agg.stopAgent().catch(() => {});

  return NextResponse.json({ success: true });
}
