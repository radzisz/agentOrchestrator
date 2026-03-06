import * as store from "@/lib/store";
import { AgentCard } from "@/components/agent-card";
import { RealTimeFeed } from "@/components/real-time-feed";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const projects = store.listProjects();
  const allAgents: Array<store.AgentData & { projectName: string }> = [];

  for (const project of projects) {
    const agents = store.listAgents(project.path);
    for (const agent of agents) {
      if (agent.uiStatus?.status !== "closed") {
        allAgents.push({ ...agent, projectName: project.name });
      }
    }
  }

  // Sort by updatedAt desc
  allAgents.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const runningCount = allAgents.filter((a) => a.uiStatus?.status === "running").length;

  // Count occupied port slots
  let portCount = 0;
  for (const project of projects) {
    for (const agent of store.listAgents(project.path)) {
      if (agent.portSlot !== undefined) portCount++;
    }
    for (const rt of store.listRuntimes(project.path)) {
      if (rt.portSlot !== undefined) portCount++;
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 bg-background px-6 py-3 border-b border-border">
        <h1 className="text-2xl font-bold">Dashboard</h1>
      </div>

      <div className="p-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Running Agents</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{runningCount}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Total Active</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{allAgents.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Projects</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{projects.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Port Slots Used</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{portCount}/100</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-3 gap-6">
          {/* Agent Grid */}
          <div className="col-span-2 space-y-4">
            <h2 className="text-lg font-semibold">Active Agents</h2>
            {allAgents.length === 0 ? (
              <p className="text-muted-foreground text-sm">No active agents</p>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {allAgents.map((agent) => (
                  <AgentCard key={`${agent.projectName}/${agent.issueId}`} agent={agent} />
                ))}
              </div>
            )}
          </div>

          {/* Real-time Feed */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Activity Feed</h2>
            <RealTimeFeed />
          </div>
        </div>
      </div>
    </div>
  );
}
