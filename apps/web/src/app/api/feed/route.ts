import { NextRequest, NextResponse } from "next/server";
import { getEvents } from "@/lib/feed-buffer";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const afterId = parseInt(req.nextUrl.searchParams.get("after") || "0", 10) || 0;
  const events = getEvents(afterId);
  return NextResponse.json(events);
}
