import { BaseRuntimeEnv, type RtenvProvisionResult, type RtenvStatusResult, type ProviderTypeSchema, type ConfigField } from "@orchestrator/contracts";
import * as api from "./supabase-api.js";

export const supabaseRtenvSchema: ProviderTypeSchema = {
  type: "supabase",
  category: "rtenv",
  displayName: "Supabase",
  fields: [
    { key: "accessToken", label: "Access Token", type: "secret", required: true, description: "Supabase Personal Access Token (sbp_...)" },
  ],
};

export const supabaseProjectFields: ConfigField[] = [
  { key: "projectRef", label: "Project Ref", type: "string", required: true, description: "Supabase project reference ID" },
];

export class SupabaseRuntimeEnv extends BaseRuntimeEnv {
  readonly name = "supabase";
  readonly schema = supabaseRtenvSchema;
  readonly projectFields = supabaseProjectFields;

  async provision(config: Record<string, string>, projectConfig: Record<string, string>, branch: string): Promise<RtenvProvisionResult> {
    const token = config.accessToken;
    const projectRef = projectConfig.projectRef;
    if (!token || !projectRef) return { status: "failed", error: "Missing accessToken or projectRef" };

    // Check existing
    const branches = await api.listBranches(token, projectRef);
    let existing = branches.find((b) => b.name === branch);

    if (!existing) {
      const created = await api.createBranch(token, projectRef, branch);
      if (!created) return { status: "failed", error: "Failed to create Supabase branch" };
      existing = created;
    }

    return {
      resourceId: existing.id,
      status: existing.status?.includes("HEALTHY") || existing.status?.includes("ACTIVE") ? "active" : "provisioning",
      url: existing.db_host || (existing.ref ? `${existing.ref}.supabase.co` : undefined),
    };
  }

  async checkStatus(config: Record<string, string>, _projectConfig: Record<string, string>, resourceId: string): Promise<RtenvStatusResult> {
    const token = config.accessToken;
    if (!token) return { status: "unknown", error: "No access token" };

    const info = await api.getBranch(token, resourceId);
    if (!info) return { status: "unknown", error: "Branch not found" };

    const s = info.status || "";
    const isActive = s.includes("HEALTHY") || s.includes("ACTIVE") || s === "RUNNING_MIGRATIONS_COMPLETE";
    const isFailed = s.includes("FAILED") || s.includes("INACTIVE");

    return {
      status: isFailed ? "failed" : isActive ? "active" : "provisioning",
      url: info.db_host || (info.ref ? `${info.ref}.supabase.co` : undefined),
      error: info.error || (isFailed ? `Branch status: ${s}` : undefined),
    };
  }

  async cleanup(config: Record<string, string>, _projectConfig: Record<string, string>, resourceId: string): Promise<void> {
    const token = config.accessToken;
    if (token) await api.deleteBranch(token, resourceId);
  }
}
