import { NextRequest, NextResponse } from "next/server";
import * as runtime from "@/services/runtime";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const runtimes = await runtime.listForProject(name);
  return NextResponse.json(runtimes);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { branch, type } = (await req.json()) as {
    branch: string;
    type: "LOCAL" | "REMOTE";
  };

  if (!branch || !type) {
    return NextResponse.json(
      { error: "branch and type are required" },
      { status: 400 }
    );
  }

  try {
    if (type === "LOCAL") {
      const runtimeId = await runtime.startLocal(name, branch);
      const result = await runtime.getRuntimeInfo(name, branch, type);
      return NextResponse.json({ runtimeId, ...result }, { status: 201 });
    }

    // REMOTE: fire-and-forget — startRemote takes minutes (Supabase provisioning).
    // Save a STARTING record immediately and return so the UI can poll.
    const safe = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
    const runtimeId = `REMOTE/${safe}`;
    runtime.startRemote(name, branch).catch((err) =>
      console.error(`[runtimes] startRemote background error for ${branch}:`, err)
    );

    // Give startRemote a moment to persist the initial STARTING record
    await new Promise((r) => setTimeout(r, 200));

    try {
      const result = await runtime.getRuntimeInfo(name, branch, type);
      return NextResponse.json({ runtimeId, ...result }, { status: 201 });
    } catch {
      // startRemote may not have saved yet — return minimal response
      return NextResponse.json(
        { runtimeId, runtime: { status: "STARTING", branch, type: "REMOTE", createdAt: new Date().toISOString() } },
        { status: 201 }
      );
    }
  } catch (error) {
    console.error("[runtimes] POST error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
