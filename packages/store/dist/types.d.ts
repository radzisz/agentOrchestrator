export interface ProjectEntry {
    name: string;
    path: string;
}
export interface TrackerInstance {
    id: string;
    type: string;
    name: string;
    isDefault: boolean;
    config: Record<string, string>;
}
export interface ProjectTrackerEntry {
    type: string;
    enabled: boolean;
    instanceId?: string;
    overrides?: Record<string, string>;
}
export interface ProjectTrackerConfig {
    trackers: ProjectTrackerEntry[];
}
export interface AIProviderInstance {
    id: string;
    type: "claude-code" | "aider";
    name: string;
    isDefault: boolean;
    config: Record<string, string>;
}
export interface IMProviderInstance {
    id: string;
    type: "telegram";
    name: string;
    isDefault: boolean;
    config: Record<string, string>;
}
export interface RepoProviderInstance {
    id: string;
    type: "github" | "gitlab";
    name: string;
    isDefault: boolean;
    config: Record<string, string>;
}
export interface AppConfig {
    projects: ProjectEntry[];
    integrations: Record<string, {
        enabled: boolean;
        config?: Record<string, string>;
    }>;
    trackerInstances?: TrackerInstance[];
    aiProviderInstances?: AIProviderInstance[];
    imProviderInstances?: IMProviderInstance[];
    repoProviderInstances?: RepoProviderInstance[];
    nextPortSlot: number;
}
export type AgentStatus = "PENDING" | "SPAWNING" | "RUNNING" | "EXITED" | "WAITING" | "PREVIEW" | "IN_REVIEW" | "MERGING" | "REBASING" | "DONE" | "CANCELLED" | "CLEANUP" | "REMOVED";
export interface AgentData {
    issueId: string;
    linearIssueUuid?: string;
    trackerSource?: string;
    trackerExternalId?: string;
    title: string;
    description?: string;
    createdBy?: string;
    status: AgentStatus;
    containerName?: string;
    branch?: string;
    agentDir?: string;
    portSlot?: number;
    servicesEnabled: boolean;
    spawned: boolean;
    previewed: boolean;
    notified: boolean;
    reassigned?: boolean;
    rebaseResult?: {
        success: boolean;
        steps: {
            cmd: string;
            ok: boolean;
            output: string;
        }[];
        error?: string;
        conflict?: boolean;
        conflictFiles?: string[];
    };
    createdAt: string;
    updatedAt: string;
    lastWakeCommentAt?: string;
    aiProviderInstanceId?: string;
    state?: unknown;
    currentOperation?: unknown;
    uiStatus?: unknown;
}
export type RuntimeType = "LOCAL" | "REMOTE";
export type RuntimeStatus = "STARTING" | "DEPLOYING" | "RUNNING" | "STOPPED" | "FAILED";
export interface RuntimeData {
    type: RuntimeType;
    status: RuntimeStatus;
    branch: string;
    mode?: "container" | "host";
    hostPids?: number[];
    servicesEnabled?: boolean;
    containerName?: string;
    portSlot?: number;
    previewUrl?: string;
    supabaseUrl?: string;
    supabaseBranchId?: string;
    servicePortMap?: Array<{
        name: string;
        hostPort: number;
        healthPath?: string;
    }>;
    netlifyDeployIds?: Array<{
        siteName: string;
        deployId: string;
    }>;
    operationLog?: Array<{
        ts: string;
        msg: string;
        ok: boolean;
    }>;
    expiresAt?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
}
export interface ProjectConfig {
    [key: string]: string;
}
//# sourceMappingURL=types.d.ts.map