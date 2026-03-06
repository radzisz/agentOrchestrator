import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { createAggregate } from "@/lib/agent-aggregate";
import { defaultAgentState } from "@/lib/agent-aggregate";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { projectName, issueId, linearIssueUuid } = body;

  if (!projectName || !issueId || !linearIssueUuid) {
    return NextResponse.json(
      { error: "projectName, issueId, and linearIssueUuid are required" },
      { status: 400 }
    );
  }

  const project = store.getProjectByName(projectName);
  if (!project) {
    return NextResponse.json({ error: `Project not found: ${projectName}` }, { status: 404 });
  }

  // Create a minimal agent record for the aggregate
  const now = new Date().toISOString();
  const agent: store.AgentData = {
    issueId,
    title: issueId,
    status: "SPAWNING",
    branch: `agent/${issueId}`,
    agentDir: undefined,
    servicesEnabled: false,
    spawned: false,
    previewed: false,
    notified: false,
    createdAt: now,
    updatedAt: now,
    state: defaultAgentState(`agent/${issueId}`),
    currentOperation: null,
  };

  const agg = createAggregate(projectName, project.path, agent);
  await agg.spawnAgent({ linearIssueUuid });

  return NextResponse.json({ agentId: issueId }, { status: 201 });
}
