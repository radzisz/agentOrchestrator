import { BaseRuntimeEnv, type RtenvProvisionResult, type RtenvStatusResult, type ProviderTypeSchema, type ConfigField } from "@orchestrator/contracts";
import * as api from "./vercel-api.js";

export interface VercelProjectConfig {
  name: string;          // service name (e.g. "web")
  projectName: string;   // vercel project name
  domain?: string;       // custom domain
}

export const vercelRtenvSchema: ProviderTypeSchema = {
  type: "vercel",
  category: "rtenv",
  displayName: "Vercel",
  fields: [
    { key: "authToken", label: "Auth Token", type: "secret", required: true, description: "Vercel Personal Access Token" },
    { key: "teamId", label: "Team ID", type: "string", description: "Optional Vercel team/org ID" },
  ],
};

export const vercelProjectFields: ConfigField[] = [
  { key: "projects", label: "Projects (JSON)", type: "string", required: true, description: 'Array of {name, projectName, domain}' },
];

export class VercelRuntimeEnv extends BaseRuntimeEnv {
  readonly name = "vercel";
  readonly schema = vercelRtenvSchema;
  readonly projectFields = vercelProjectFields;

  private parseProjects(projectConfig: Record<string, string>): VercelProjectConfig[] {
    try { return JSON.parse(projectConfig.projects || "[]"); } catch { return []; }
  }

  async provision(config: Record<string, string>, projectConfig: Record<string, string>, branch: string): Promise<RtenvProvisionResult> {
    const token = config.authToken;
    const teamId = config.teamId;
    const projects = this.parseProjects(projectConfig);
    if (!token) return { status: "failed", error: "Missing authToken" };
    if (projects.length === 0) return { status: "failed", error: "No projects configured" };

    const deployIds: Array<{ name: string; id: string }> = [];
    const previewUrls: string[] = [];

    for (const proj of projects) {
      const deployment = await api.createDeployment(token, proj.projectName, branch, { teamId });
      if (deployment) {
        deployIds.push({ name: proj.name, id: deployment.uid || deployment.id });
        const url = deployment.url?.startsWith("http") ? deployment.url : `https://${deployment.url}`;
        previewUrls.push(url);
      }
    }

    return {
      status: deployIds.length > 0 ? "provisioning" : "failed",
      previewUrls,
      deployIds,
      error: deployIds.length === 0 ? "No deployments created" : undefined,
    };
  }

  async checkStatus(config: Record<string, string>, _projectConfig: Record<string, string>, resourceId: string): Promise<RtenvStatusResult> {
    const token = config.authToken;
    const teamId = config.teamId;
    if (!token) return { status: "unknown", error: "No auth token" };

    let deployIds: Array<{ name: string; id: string }>;
    try { deployIds = JSON.parse(resourceId); } catch { return { status: "unknown" }; }

    const deploys: RtenvStatusResult["deploys"] = [];
    let allReady = true;
    let anyFailed = false;

    for (const { name, id } of deployIds) {
      const d = await api.getDeployment(token, id, teamId);
      if (!d) {
        deploys.push({ name, state: "unknown" });
        allReady = false;
        continue;
      }
      const state = (d.readyState || d.state || "").toUpperCase();
      deploys.push({
        name,
        state,
        url: d.url?.startsWith("http") ? d.url : `https://${d.url}`,
        error: d.error?.message,
      });
      if (state === "ERROR" || state === "CANCELED") anyFailed = true;
      if (state !== "READY") allReady = false;
    }

    return {
      status: anyFailed ? "failed" : allReady ? "active" : "provisioning",
      deploys,
    };
  }

  async cleanup(config: Record<string, string>, _projectConfig: Record<string, string>, resourceId: string): Promise<void> {
    const token = config.authToken;
    const teamId = config.teamId;
    if (!token) return;

    let deployIds: Array<{ name: string; id: string }>;
    try { deployIds = JSON.parse(resourceId); } catch { return; }

    for (const { id } of deployIds) {
      await api.cancelDeployment(token, id, teamId);
    }
  }

  async setEnvVars(config: Record<string, string>, projectConfig: Record<string, string>, vars: Record<string, string>, branch: string): Promise<void> {
    const token = config.authToken;
    const teamId = config.teamId;
    if (!token) return;
    const projects = this.parseProjects(projectConfig);

    for (const proj of projects) {
      for (const [key, value] of Object.entries(vars)) {
        await api.setEnvVar(token, proj.projectName, key, value, ["preview"], branch, teamId);
      }
    }
  }
}
