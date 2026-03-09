import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";

export async function GET() {
  return NextResponse.json({ rules: store.getAIRules() });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  if (!Array.isArray(body.rules)) {
    return NextResponse.json({ error: "rules must be an array" }, { status: 400 });
  }
  store.saveAIRules(body.rules);
  return NextResponse.json({ rules: store.getAIRules() });
}
