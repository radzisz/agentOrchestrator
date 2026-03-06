import { NextRequest, NextResponse } from "next/server";
import { findAggregate } from "@/lib/agent-aggregate";

/** Lightweight endpoint returning live state + uiStatus + currentOperation.
 *  Returns cached state — refresh is handled by the monitor background service. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({
    state: agg.state,
    uiStatus: agg.uiStatus,
    currentOperation: agg.currentOperation,
  });
}
