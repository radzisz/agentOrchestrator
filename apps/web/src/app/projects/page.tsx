import { existsSync } from "fs";
import { join } from "path";
import * as store from "@/lib/store";
import { ProjectForm } from "./project-form";
import { ScanProjects } from "./scan-projects";
import { getBasePath } from "@/integrations/local-drive";
import { ProjectList } from "./project-list";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const projects = store.listProjects();
  const basePath = await getBasePath();

  const projectsData = projects.map((project) => {
    const agents = store.listAgents(project.path);
    const cfg = store.getProjectConfig(project.path);

    // Visible agents = not closed (matches what the project detail page shows)
    const visible = agents.filter((a) => a.uiStatus?.status !== "closed");
    const running = visible.filter((a) => a.uiStatus?.status === "running").length;
    const awaiting = visible.filter((a) => a.uiStatus?.status === "awaiting").length;
    const active = visible.length;
    const total = agents.length;

    return {
      name: project.name,
      path: project.path,
      repoUrl: cfg.REPO_URL || null,
      hasGit: existsSync(join(project.path, ".git")),
      running,
      active,
      awaiting,
      total,
    };
  });

  return (
    <div>
      <div className="sticky top-0 z-10 bg-background px-6 py-3 border-b border-border flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <ProjectForm />
      </div>

      <div className="p-6 space-y-6">
        <ProjectList projects={projectsData} />
        {projects.length === 0 && <ScanProjects basePath={basePath} />}
      </div>
    </div>
  );
}
