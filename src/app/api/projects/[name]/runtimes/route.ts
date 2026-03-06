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
    const runtimeId =
      type === "LOCAL"
        ? await runtime.startLocal(name, branch)
        : await runtime.startRemote(name, branch);

    const result = await runtime.getRuntimeInfo(
      name,
      branch,
      type
    );
    return NextResponse.json({ runtimeId, ...result }, { status: 201 });
  } catch (error) {
    console.error("[runtimes] POST error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
