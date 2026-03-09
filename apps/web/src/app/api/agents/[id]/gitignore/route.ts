import { NextRequest, NextResponse } from "next/server";
import { appendFileSync, readFileSync } from "fs";
import { join } from "path";
import * as gitSvc from "@/services/git";
import { findAgentWithProject } from "@/lib/agent-aggregate/find-agent";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { patterns } = await req.json() as { patterns: string[] };

  if (!patterns || patterns.length === 0) {
    return NextResponse.json({ error: "No patterns provided" }, { status: 400 });
  }

  const found = findAgentWithProject(id);
  if (!found || !found.agent.agentDir) {
    return NextResponse.json({ error: "Agent or directory not found" }, { status: 404 });
  }

  const dir = found.agent.agentDir;

  try {
    // Append patterns to .gitignore
    const gitignorePath = join(dir, ".gitignore");
    let existing = "";
    try { existing = readFileSync(gitignorePath, "utf-8"); } catch {}
    const newLines = patterns.map((p) => p.trim()).filter(Boolean);
    const toAdd = newLines.filter((l) => !existing.includes(l));
    if (toAdd.length > 0) {
      appendFileSync(gitignorePath, (existing.endsWith("\n") ? "" : "\n") + toAdd.join("\n") + "\n", "utf-8");
    }

    const result = await gitSvc.commitAndPush(dir, "chore: update .gitignore", {
      files: [".gitignore"],
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
