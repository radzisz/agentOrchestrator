// ---------------------------------------------------------------------------
// GitHubSCMProvider — implements BaseSCMProvider with config-as-parameter
// ---------------------------------------------------------------------------
import { BaseSCMProvider, } from "@orchestrator/contracts";
import * as gh from "./github-api.js";
export const githubSchema = {
    type: "github",
    category: "scm",
    displayName: "GitHub",
    fields: [
        { key: "token", label: "Personal Access Token", type: "secret", required: true, description: "GitHub PAT with repo scope" },
    ],
};
export class GitHubSCMProvider extends BaseSCMProvider {
    constructor() {
        super(...arguments);
        this.name = "github";
        this.schema = githubSchema;
    }
    async listBranches(config, owner, repo, mainBranch) {
        const token = config.token;
        if (!token)
            return [];
        return gh.listBranches(token, owner, repo, mainBranch);
    }
    async createPR(config, owner, repo, head, base, title, body) {
        const token = config.token;
        if (!token)
            throw new Error("GitHub token not configured");
        return gh.createPullRequest(token, owner, repo, { head, base, title, body });
    }
    async getBranchCommits(config, owner, repo, branch, perPage) {
        const token = config.token;
        if (!token)
            return [];
        return gh.getBranchCommits(token, owner, repo, branch, perPage);
    }
    async getDefaultBranch(config, owner, repo) {
        const token = config.token;
        if (!token)
            return "main";
        return gh.getDefaultBranch(token, owner, repo);
    }
}
//# sourceMappingURL=provider.js.map