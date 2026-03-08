import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";

export async function GET(req: NextRequest) {
  const projectName = req.nextUrl.searchParams.get("projectName");

  const projects = store.listProjects();
  const allAgents: Array<store.AgentData & { projectName: string }> = [];

  for (const project of projects) {
    if (projectName && project.name !== projectName) continue;
    const agents = store.listAgents(project.path);
    for (const agent of agents) {
      allAgents.push({ ...agent, projectName: project.name });
    }
  }

  // Sort by updatedAt desc
  allAgents.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return NextResponse.json(allAgents);
}
