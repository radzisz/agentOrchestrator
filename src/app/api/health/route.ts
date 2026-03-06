import { NextRequest, NextResponse } from "next/server";
import { getContainerLogs } from "@/lib/docker";
import * as store from "@/lib/store";

/**
 * GET /api/health?port=40922&runtimeId=LOCAL/agent-UKR-112&service=guide&projectName=ukryte_skarby
 */
export async function GET(req: NextRequest) {
  const port = req.nextUrl.searchParams.get("port");
  const url = req.nextUrl.searchParams.get("url");
  const runtimeId = req.nextUrl.searchParams.get("runtimeId");
  const service = req.nextUrl.searchParams.get("service");
  const projectName = req.nextUrl.searchParams.get("projectName");
  const healthPath = req.nextUrl.searchParams.get("healthPath");

  // External URL health check
  if (url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);
      return NextResponse.json({
        up: resp.ok || resp.status < 500,
        error: null,
      });
    } catch {
      return NextResponse.json({ up: false, error: null });
    }
  }

  if (!port) {
    return NextResponse.json({ up: false, error: null });
  }

  // Check logs for service-specific errors
  let error: string | null = null;
  if (runtimeId && service && projectName) {
    error = await detectServiceError(projectName, runtimeId, service);
  }

  if (error) {
    return NextResponse.json({ up: false, error });
  }

  // Check port
  const checkPath = healthPath || "/";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`http://localhost:${port}${checkPath}`, {
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    return NextResponse.json({
      up: resp.ok || resp.status < 500,
      error: null,
    });
  } catch {
    return NextResponse.json({ up: false, error: null });
  }
}

async function detectServiceError(
  projectName: string,
  runtimeId: string,
  serviceName: string
): Promise<string | null> {
  try {
    const project = store.getProjectByName(projectName);
    if (!project) return null;

    // Parse runtimeId to find the runtime
    const parts = runtimeId.split("/");
    if (parts.length < 2) return null;
    const type = parts[0] as store.RuntimeType;
    const safeBranch = parts.slice(1).join("/");

    const runtimes = store.listRuntimes(project.path);
    const runtime = runtimes.find(
      (rt) => rt.type === type && rt.branch.replace(/[^a-zA-Z0-9_-]/g, "-") === safeBranch
    );
    if (!runtime?.containerName) return null;

    // Get runtime services config
    const runtimeServices = store.getProjectJsonField<Array<{ name: string; cmd: string }>>(project.path, "RUNTIME_SERVICES");
    const svcConfig = runtimeServices?.find((s) => s.name === serviceName);
    if (!svcConfig) return null;

    const wsMatch = svcConfig.cmd.match(/-w\s+(\S+)/);
    const workspace = wsMatch?.[1];

    const logs = await getContainerLogs(runtime.containerName, 200);
    if (!logs) return null;

    const lines = logs.split("\n");
    const pkg = workspace?.split("/").pop();
    const errorPatterns = [
      /: not found$/,
      pkg ? new RegExp(`npm error.*${pkg}`, "i") : null,
      workspace ? new RegExp(`Lifecycle script.*failed.*${pkg}`, "i") : null,
    ].filter(Boolean) as RegExp[];

    let inServiceBlock = false;
    const errorLines: string[] = [];

    for (const line of lines) {
      if (pkg && line.includes(pkg) && /^\s*>/.test(line)) {
        inServiceBlock = true;
        continue;
      }
      if (inServiceBlock && /^\s*>.*@.*start/.test(line) && pkg && !line.includes(pkg)) {
        inServiceBlock = false;
      }

      if (inServiceBlock) {
        if (
          line.includes("not found") ||
          line.includes("npm error") ||
          line.includes("ERR!") ||
          line.includes("Error:") ||
          line.includes("failed with error") ||
          line.includes("ENOENT") ||
          line.includes("code 127")
        ) {
          errorLines.push(line.trim());
        }
      }

      for (const pattern of errorPatterns) {
        if (pattern.test(line)) {
          errorLines.push(line.trim());
        }
      }
    }

    if (errorLines.length > 0) {
      const unique = [...new Set(errorLines)];
      return unique.slice(0, 3).join("\n");
    }

    return null;
  } catch {
    return null;
  }
}
