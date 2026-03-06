import { NextRequest, NextResponse } from "next/server";
import { findAggregate } from "@/lib/agent-aggregate";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  const info = await agg.getMergeInfo();
  return NextResponse.json(info);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agg = findAggregate(id);
  if (!agg) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  const body = await req.json();

  if (body.action === "reject") {
    agg.reject(body.closeIssue !== false).then(() => {
      if (body.cleanup) return agg.removeAgent();
    }).catch((err) => {
      console.error(`[merge] reject failed for ${agg.issueId}:`, err);
    });
    return NextResponse.json({ success: true, action: "rejected" });
  }

  // Merge in background
  agg.mergeAndClose({
    toggle: body.toggle,
    enableToggle: body.enableToggle,
    closeIssue: body.closeIssue !== false,
    cleanup: body.cleanup,
    skipMerge: !!body.skipMerge,
  }).catch((err) => {
    console.error(`[merge] merge failed for ${agg.issueId}:`, err);
  });

  return NextResponse.json({ success: true, action: "merging" });
}
