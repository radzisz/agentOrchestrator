import { NextRequest, NextResponse } from "next/server";
import { findAggregate } from "@/lib/agent-aggregate";
import { getLiveOutput } from "@/lib/agent-aggregate/operations/agent-process";

/** Return the last N lines of Claude's live output (kept in-memory). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const tail = parseInt(req.nextUrl.searchParams.get("tail") || "30");
  const output = getLiveOutput(agg.issueId, tail);

  return NextResponse.json({
    output,
    running: agg.snapshot.agent === "running",
  });
}
