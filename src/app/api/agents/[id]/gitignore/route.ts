import { NextRequest, NextResponse } from "next/server";
import { appendFileSync, readFileSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";

const SRC = "gitignore";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { patterns } = await req.json() as { patterns: string[] };

  if (!patterns || patterns.length === 0) {
    return NextResponse.json({ error: "No patterns provided" }, { status: 400 });
  }

  const projects = store.listProjects();
  let agent: store.AgentData | null = null;
  for (const project of projects) {
    agent = store.getAgent(project.path, id);
    if (agent) break;
  }

  if (!agent || !agent.agentDir) {
    return NextResponse.json({ error: "Agent or directory not found" }, { status: 404 });
  }

  const dir = agent.agentDir;

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

    // Stage .gitignore + commit + push
    await cmd.git(`-C "${dir}" config user.email "agent@10timesdev.com"`, { source: SRC });
    await cmd.git(`-C "${dir}" config user.name "10timesdev"`, { source: SRC });
    await cmd.git(`-C "${dir}" add .gitignore`, { source: SRC });
    const commitR = await cmd.git(`-C "${dir}" commit -m "chore: update .gitignore"`, { source: SRC });
    if (!commitR.ok) {
      return NextResponse.json({ error: commitR.stderr || "Commit failed" }, { status: 500 });
    }
    const pushR = await cmd.git(`-C "${dir}" push origin HEAD`, { source: SRC, timeout: 30000 });
    if (!pushR.ok) {
      return NextResponse.json({ error: pushR.stderr || "Push failed" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
