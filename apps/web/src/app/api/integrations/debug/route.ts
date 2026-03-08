import { NextRequest, NextResponse } from "next/server";
import { appendLog, getAllLogs } from "@/integrations/registry";
import * as store from "@/lib/store";
import { resolveTrackerConfig } from "@/lib/issue-trackers/registry";

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
        const resolved = resolveTrackerConfig(p.path, "linear");
        const teamKey = resolved?.teamKey || "";
        const label = resolved?.label || "agent";
        const apiKey = resolved?.apiKey;
        const teamId = resolved?.teamId;
        buf.push({ ts: new Date().toISOString(), message: `[debug] Project: ${p.name} team=${teamKey} label=${label} hasKey=${!!apiKey}` });

        if (apiKey && teamId) {
          const { linearApi: linear } = await import("@orchestrator/tracker-linear");
          const issues = await linear.getAgentIssues(apiKey, teamId, label);
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
