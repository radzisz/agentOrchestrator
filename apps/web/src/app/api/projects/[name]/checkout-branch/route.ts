import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import * as store from "@/lib/store";
import * as gitSvc from "@/services/git";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!existsSync(project.path)) {
    return NextResponse.json(
      { error: `Project directory does not exist: ${project.path}` },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { branch } = body as { branch: string };

  if (!branch) {
    return NextResponse.json({ error: "branch is required" }, { status: 400 });
  }

  try {
    const result = await gitSvc.fetchAndCheckout(project.path, branch);
    if (!result.ok) {
      return NextResponse.json(
        { error: `Failed to checkout: ${result.error}` },
        { status: 500 }
      );
    }

    // Switch back to the default branch so the main repo isn't left on an agent branch
    await gitSvc.checkoutDefault(project.path);

    return NextResponse.json({ ok: true, branch });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to checkout: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
