import { BaseRuntimeEnv, type RtenvProvisionResult, type RtenvStatusResult, type ProviderTypeSchema, type ConfigField } from "@orchestrator/contracts";
import * as api from "./netlify-api.js";

export interface NetlifySiteConfig {
  name: string;       // service name (e.g. "guide")
  siteName: string;   // netlify site name (e.g. "ukryteskarby-guide")
  domain?: string;    // custom domain (e.g. "guide.example.com")
}

export const netlifyRtenvSchema: ProviderTypeSchema = {
  type: "netlify",
  category: "rtenv",
  displayName: "Netlify",
  fields: [
    { key: "authToken", label: "Auth Token", type: "secret", required: true, description: "Netlify Personal Access Token (nfp_...)" },
  ],
};

export const netlifyProjectFields: ConfigField[] = [
  { key: "sites", label: "Sites (JSON)", type: "string", required: true, description: 'Array of {name, siteName, domain}' },
];

export class NetlifyRuntimeEnv extends BaseRuntimeEnv {
  readonly name = "netlify";
  readonly schema = netlifyRtenvSchema;
  readonly projectFields = netlifyProjectFields;

  private parseSites(projectConfig: Record<string, string>): NetlifySiteConfig[] {
    try { return JSON.parse(projectConfig.sites || "[]"); } catch { return []; }
  }

  async provision(config: Record<string, string>, projectConfig: Record<string, string>, branch: string): Promise<RtenvProvisionResult> {
    const token = config.authToken;
    const sites = this.parseSites(projectConfig);
    if (!token) return { status: "failed", error: "Missing authToken" };
    if (sites.length === 0) return { status: "failed", error: "No sites configured" };

    const safeBranch = branch.replace("/", "-").toLowerCase();
    const deployIds: Array<{ name: string; id: string }> = [];
    const previewUrls: string[] = [];

    for (const site of sites) {
      const siteInfo = await api.getSite(token, site.siteName);
      if (!siteInfo) {
        previewUrls.push(`https://${safeBranch}--${site.siteName}.netlify.app`);
        continue;
      }

      const result = await api.triggerBuild(token, siteInfo.id, branch);
      if (result) {
        deployIds.push({ name: site.name, id: result.deployId });
      }
      const domain = site.domain || `${site.siteName}.netlify.app`;
      previewUrls.push(`https://${safeBranch}--${domain}`);
    }

    return {
      status: deployIds.length > 0 ? "provisioning" : "active",
      previewUrls,
      deployIds,
    };
  }

  async checkStatus(config: Record<string, string>, _projectConfig: Record<string, string>, resourceId: string): Promise<RtenvStatusResult> {
    const token = config.authToken;
    if (!token) return { status: "unknown", error: "No auth token" };

    // resourceId is JSON-encoded deploy IDs array
    let deployIds: Array<{ name: string; id: string }>;
    try { deployIds = JSON.parse(resourceId); } catch { return { status: "unknown" }; }

    const deploys: RtenvStatusResult["deploys"] = [];
    let allReady = true;
    let anyFailed = false;

    for (const { name, id } of deployIds) {
      const deploy = await api.getDeploy(token, id);
      if (!deploy) {
        deploys.push({ name, state: "unknown" });
        allReady = false;
        continue;
      }
      deploys.push({
        name,
        state: deploy.state,
        url: deploy.deploy_ssl_url,
        error: deploy.error_message,
      });
      if (deploy.state === "error") anyFailed = true;
      if (deploy.state !== "ready") allReady = false;
    }

    return {
      status: anyFailed ? "failed" : allReady ? "active" : "provisioning",
      deploys,
    };
  }

  async cleanup(_config: Record<string, string>, _projectConfig: Record<string, string>, _resourceId: string): Promise<void> {
    // Netlify branch deploys expire naturally, no cleanup needed
  }

  async setEnvVars(config: Record<string, string>, projectConfig: Record<string, string>, vars: Record<string, string>, branch: string): Promise<void> {
    const token = config.authToken;
    if (!token) return;
    const sites = this.parseSites(projectConfig);

    for (const site of sites) {
      const siteInfo = await api.getSite(token, site.siteName);
      if (!siteInfo) continue;
      for (const [key, value] of Object.entries(vars)) {
        await api.setEnvVar(token, siteInfo.account_id, key, value, branch);
      }
    }
  }
}
