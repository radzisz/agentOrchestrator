export declare function parseRepoUrl(url: string): {
    owner: string;
    repo: string;
} | null;
export interface GHBranch {
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
export declare function listBranches(token: string, owner: string, repo: string, mainBranch?: string): Promise<GHBranch[]>;
export declare function createPullRequest(token: string, owner: string, repo: string, options: {
    head: string;
    base?: string;
    title: string;
    body?: string;
    draft?: boolean;
}): Promise<{
    number: number;
    url: string;
}>;
export declare function getBranchCommits(token: string, owner: string, repo: string, branch: string, perPage?: number): Promise<Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
}>>;
export declare function getDefaultBranch(token: string, owner: string, repo: string): Promise<string>;
//# sourceMappingURL=github-api.d.ts.map