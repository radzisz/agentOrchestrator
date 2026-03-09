import type { ConfigField, ProviderTypeSchema } from "./config-schema";
export interface RtenvProvisionResult {
    /** Provider-specific branch/resource id (e.g. Supabase branch id) */
    resourceId?: string;
    status: "provisioning" | "active" | "failed";
    /** Primary URL (e.g. db_host for Supabase, deploy URL for Netlify/Vercel) */
    url?: string;
    /** Preview URLs per service */
    previewUrls?: string[];
    /** Deploy IDs per service (Netlify/Vercel) */
    deployIds?: Array<{
        name: string;
        id: string;
    }>;
    error?: string;
}
export interface RtenvStatusResult {
    status: "provisioning" | "active" | "failed" | "unknown";
    url?: string;
    error?: string;
    deploys?: Array<{
        name: string;
        state: string;
        url?: string;
        error?: string;
    }>;
}
export declare abstract class BaseRuntimeEnv {
    abstract readonly name: string;
    abstract readonly schema: ProviderTypeSchema;
    /** Fields shown in per-project config */
    abstract readonly projectFields: ConfigField[];
    /** Provision resources for a branch (create DB branch, trigger deploy, etc.) */
    abstract provision(config: Record<string, string>, projectConfig: Record<string, string>, branch: string): Promise<RtenvProvisionResult>;
    /** Check status of a previously provisioned resource */
    abstract checkStatus(config: Record<string, string>, projectConfig: Record<string, string>, resourceId: string): Promise<RtenvStatusResult>;
    /** Clean up resources for a branch */
    abstract cleanup(config: Record<string, string>, projectConfig: Record<string, string>, resourceId: string): Promise<void>;
    /** Set environment variables on deploy target (optional) */
    setEnvVars?(config: Record<string, string>, projectConfig: Record<string, string>, vars: Record<string, string>, branch: string): Promise<void>;
    /** Trigger deploy for a branch (optional — some providers do this in provision) */
    triggerDeploy?(config: Record<string, string>, projectConfig: Record<string, string>, branch: string): Promise<Array<{
        name: string;
        deployId: string;
    }>>;
}
//# sourceMappingURL=runtime-env.d.ts.map