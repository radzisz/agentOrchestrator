import type { ProviderTypeSchema } from "./config-schema";
export interface SCMBranch {
    name: string;
    commit: {
        sha: string;
        message: string;
        author: string;
        date: string;
    };
    aheadBy: number;
    behindBy: number;
    pullRequest: {
        number: number;
        title: string;
        state: string;
        url: string;
    } | null;
}
export declare abstract class BaseSCMProvider {
    abstract readonly name: string;
    abstract readonly schema: ProviderTypeSchema;
    abstract listBranches(config: Record<string, string>, owner: string, repo: string, mainBranch: string): Promise<SCMBranch[]>;
    createPR?(config: Record<string, string>, owner: string, repo: string, head: string, base: string, title: string, body: string): Promise<{
        number: number;
        url: string;
    }>;
    getBranchCommits?(config: Record<string, string>, owner: string, repo: string, branch: string, perPage?: number): Promise<Array<{
        sha: string;
        message: string;
        author: string;
        date: string;
    }>>;
    getDefaultBranch?(config: Record<string, string>, owner: string, repo: string): Promise<string>;
}
//# sourceMappingURL=scm-provider.d.ts.map