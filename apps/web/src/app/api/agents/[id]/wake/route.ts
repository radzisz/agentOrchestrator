import { NextRequest, NextResponse } from "next/server";
import { findAggregate } from "@/lib/agent-aggregate";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const force = body.force === true;

  // If agent is running and not a force interrupt — queue the message
  if (agg.snapshot.agent === "running" && body.message && !force) {
    agg.queueMessage(body.message);
    return NextResponse.json({ success: true, queued: true });
  }

  // Set transition immediately so UI reflects "starting" while wake runs in background
  agg.prepareWake();

  // Fire-and-forget — wake runs in background, UI polls transition state
  agg.wakeAgent(body.message, { reset: body.reset }).catch(() => {});

  return NextResponse.json({ success: true, queued: false });
}
