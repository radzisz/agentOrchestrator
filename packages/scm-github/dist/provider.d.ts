import { BaseSCMProvider, type SCMBranch, type ProviderTypeSchema } from "@orchestrator/contracts";
export declare const githubSchema: ProviderTypeSchema;
export declare class GitHubSCMProvider extends BaseSCMProvider {
    readonly name = "github";
    readonly schema: ProviderTypeSchema;
    listBranches(config: Record<string, string>, owner: string, repo: string, mainBranch: string): Promise<SCMBranch[]>;
    createPR(config: Record<string, string>, owner: string, repo: string, head: string, base: string, title: string, body: string): Promise<{
        number: number;
        url: string;
    }>;
    getBranchCommits(config: Record<string, string>, owner: string, repo: string, branch: string, perPage?: number): Promise<Array<{
        sha: string;
        message: string;
        author: string;
        date: string;
    }>>;
    getDefaultBranch(config: Record<string, string>, owner: string, repo: string): Promise<string>;
}
//# sourceMappingURL=provider.d.ts.map