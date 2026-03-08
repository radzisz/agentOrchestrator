import * as store from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProjectForm } from "./project-form";
import { ScanProjects } from "./scan-projects";
import { getBasePath } from "@/integrations/local-drive";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const projects = store.listProjects();
  const basePath = await getBasePath();

  return (
    <div>
      <div className="sticky top-0 z-10 bg-background px-6 py-3 border-b border-border flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <ProjectForm />
      </div>

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 gap-4">
          {projects.map((project) => {
            const agents = store.listAgents(project.path);
            const activeCount = agents.filter((a) => !["DONE", "CANCELLED"].includes(a.status)).length;
            return (
              <Card key={project.name}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>
                      <a href={`/projects/${project.name}`} className="hover:underline">
                        {project.name}
                      </a>
                    </CardTitle>
                    <Badge variant="secondary">{activeCount} active</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-sm text-muted-foreground space-y-1">
                    <p>Total agents: {agents.length}</p>
                  </div>
                  <div className="mt-3">
                    <Button variant="outline" size="sm" asChild>
                      <a href={`/projects/${project.name}`}>View</a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {projects.length === 0 && <ScanProjects basePath={basePath} />}
      </div>
    </div>
  );
}
