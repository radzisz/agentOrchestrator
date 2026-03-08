import { NextRequest, NextResponse } from "next/server";
import { findAggregate, findAgentInfo } from "@/lib/agent-aggregate";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const status = await agg.getStatus();
  return NextResponse.json(status);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const closeIssue = req.nextUrl.searchParams.get("closeIssue") !== "false";
  const deleteBranch = req.nextUrl.searchParams.get("deleteBranch") !== "false";

  agg.removeAgent({ closeIssue, deleteBranch }).catch((err) => {
    console.error(`[agent] cleanup failed for ${id}:`, err);
  });

  return NextResponse.json({ ok: true, removed: agg.issueId });
}
