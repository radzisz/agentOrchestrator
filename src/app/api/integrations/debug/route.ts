import { NextRequest, NextResponse } from "next/server";
import { appendLog, getAllLogs } from "@/integrations/registry";
import * as store from "@/lib/store";

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");

  // Manual tick trigger
  if (action === "tick") {
    const g = globalThis as any;
    if (!g.__integrationLogs) g.__integrationLogs = new Map();
    let buf = g.__integrationLogs.get("linear");
    if (!buf) { buf = []; g.__integrationLogs.set("linear", buf); }
    buf.push({ ts: new Date().toISOString(), message: "[debug] Manual tick triggered" });

    try {
      const projects = store.listProjects();
      buf.push({ ts: new Date().toISOString(), message: `[debug] Found ${projects.length} projects` });

      for (const p of projects) {
        const cfg = store.getProjectConfig(p.path);
        buf.push({ ts: new Date().toISOString(), message: `[debug] Project: ${p.name} team=${cfg.LINEAR_TEAM_KEY || ""} label=${cfg.LINEAR_LABEL || "agent"} hasKey=${!!cfg.LINEAR_API_KEY}` });

        if (cfg.LINEAR_API_KEY && cfg.LINEAR_TEAM_ID) {
          const linear = await import("@/services/linear");
          const issues = await linear.getAgentIssues(cfg.LINEAR_API_KEY, cfg.LINEAR_TEAM_ID, cfg.LINEAR_LABEL || "agent");
          buf.push({ ts: new Date().toISOString(), message: `[debug] ${p.name}: ${issues.length} issues from Linear` });
          for (const issue of issues) {
            buf.push({ ts: new Date().toISOString(), message: `[debug]   ${issue.identifier} [${issue.state.name}] ${issue.title}` });
          }
        }
      }
    } catch (error) {
      buf.push({ ts: new Date().toISOString(), message: `[debug] Error: ${error}` });
    }

    return NextResponse.json({ ok: true, logs: buf });
  }

  // Default: show diagnostics
  appendLog("_debug", "Debug endpoint called");
  const g = globalThis as any;
  const hasGlobal = !!g.__integrationLogs;
  const globalKeys = hasGlobal ? Array.from(g.__integrationLogs.keys()) : [];
  const globalSizes: Record<string, number> = {};
  if (hasGlobal) {
    for (const [k, v] of g.__integrationLogs) {
      globalSizes[k] = (v as any[]).length;
    }
  }

  return NextResponse.json({
    hasGlobal,
    globalKeys,
    globalSizes,
    allLogs: getAllLogs(),
  });
}
