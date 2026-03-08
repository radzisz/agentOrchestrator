import { NextRequest, NextResponse } from "next/server";
import { findAggregate } from "@/lib/agent-aggregate";

/** Lightweight endpoint returning live state + uiStatus + currentOperation.
 *  Refreshes state from actual system (debounced) so UI gets accurate data. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  await agg.refreshAgent().catch(() => {});

  return NextResponse.json({
    state: agg.snapshot,
    uiStatus: agg.uiStatus,
    currentOperation: agg.currentOperation,
  });
}
