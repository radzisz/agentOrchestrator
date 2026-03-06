import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as runtime from "@/services/runtime";
import { getRuntimeLogs } from "@/services/runtime";

/**
 * Catch-all route for /api/projects/[name]/runtimes/[...runtimeId]
 *
 * Handles:
 *   GET  /runtimes/REMOTE/safe-branch        → runtime info
 *   GET  /runtimes/REMOTE/safe-branch/logs    → runtime logs
 *   PATCH /runtimes/REMOTE/safe-branch        → extend TTL
 *   DELETE /runtimes/REMOTE/safe-branch       → stop runtime
 */

function parseSegments(segments: string[]): { idSegments: string[]; action: string | null } {
  if (segments.length >= 3 && segments[segments.length - 1] === "logs") {
    return { idSegments: segments.slice(0, -1), action: "logs" };
  }
  return { idSegments: segments, action: null };
}

function parseRuntimeId(segments: string[]): { type: store.RuntimeType; safeBranch: string } | null {
  if (segments.length < 2) return null;
  const type = segments[0] as store.RuntimeType;
  if (type !== "LOCAL" && type !== "REMOTE") return null;
  const safeBranch = segments.slice(1).join("-");
  return { type, safeBranch };
}

function findRuntime(projectName: string, segments: string[]) {
  const parsed = parseRuntimeId(segments);
  if (!parsed) return null;

  const project = store.getProjectByName(projectName);
  if (!project) return null;

  const runtimes = store.listRuntimes(project.path);
  const safeBranch = (branch: string) => branch.replace(/[^a-zA-Z0-9_-]/g, "-");

  for (const rt of runtimes) {
    if (rt.type === parsed.type && safeBranch(rt.branch) === parsed.safeBranch) {
      return rt;
    }
  }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string; runtimeId: string[] }> }
) {
  const { name, runtimeId } = await params;
  const { idSegments, action } = parseSegments(runtimeId);

  try {
    const rt = findRuntime(name, idSegments);
    if (!rt) {
      return NextResponse.json({ error: "Runtime not found" }, { status: 404 });
    }

    // /logs sub-action
    if (action === "logs") {
      const tail = parseInt(req.nextUrl.searchParams.get("tail") || "100", 10);
      const logs = await getRuntimeLogs(name, rt.branch, rt.type, tail);
      return NextResponse.json({ logs });
    }

    const result = await runtime.getRuntimeInfo(name, rt.branch, rt.type);

    // For REMOTE runtimes in DEPLOYING state, check fresh status
    if (rt.type === "REMOTE" && rt.status === "DEPLOYING") {
      const remoteStatus = await runtime.checkRemoteStatus(name, rt.branch);
      const updated = await runtime.getRuntimeInfo(name, rt.branch, rt.type);
      return NextResponse.json({ ...updated, remoteStatus });
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Runtime not found" }, { status: 404 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string; runtimeId: string[] }> }
) {
  const { name, runtimeId } = await params;
  const { idSegments } = parseSegments(runtimeId);

  try {
    const rt = findRuntime(name, idSegments);
    if (!rt) {
      return NextResponse.json({ error: "Runtime not found" }, { status: 404 });
    }

    const { hours } = await req.json();
    await runtime.extendTTL(name, rt.branch, hours || 24);
    const result = await runtime.getRuntimeInfo(name, rt.branch, rt.type);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string; runtimeId: string[] }> }
) {
  const { name, runtimeId } = await params;
  const { idSegments } = parseSegments(runtimeId);

  try {
    const rt = findRuntime(name, idSegments);
    if (!rt) {
      return NextResponse.json({ error: "Runtime not found" }, { status: 404 });
    }

    const log = await runtime.stopRuntime(name, rt.branch, rt.type);
    return NextResponse.json({ ok: true, log });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
