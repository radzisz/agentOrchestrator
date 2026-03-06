import { NextRequest, NextResponse } from "next/server";
import { getLogs, getAllLogs } from "@/integrations/registry";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");

  if (name) {
    return NextResponse.json(getLogs(name));
  }

  return NextResponse.json(getAllLogs());
}
