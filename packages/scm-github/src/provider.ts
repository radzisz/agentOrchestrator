// ---------------------------------------------------------------------------
// GitHubSCMProvider — implements BaseSCMProvider with config-as-parameter
// ---------------------------------------------------------------------------

import {
  BaseSCMProvider,
  type SCMBranch,
  type ProviderTypeSchema,
} from "@orchestrator/contracts";
import * as gh from "./github-api.js";

export const githubSchema: ProviderTypeSchema = {
  type: "github",
  category: "scm",
  displayName: "GitHub",
  fields: [
    { key: "token", label: "Personal Access Token", type: "secret", required: true, description: "GitHub PAT with repo scope" },
  ],
};

export class GitHubSCMProvider extends BaseSCMProvider {
  readonly name = "github";
  readonly schema = githubSchema;

  async listBranches(
    config: Record<string, string>,
    owner: string,
    repo: string,
    mainBranch: string,
  ): Promise<SCMBranch[]> {
    const token = config.token;
    if (!token) return [];
    return gh.listBranches(token, owner, repo, mainBranch);
  }

  override async createPR(
    config: Record<string, string>,
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string }> {
    const token = config.token;
    if (!token) throw new Error("GitHub token not configured");
    return gh.createPullRequest(token, owner, repo, { head, base, title, body });
  }

  override async getBranchCommits(
    config: Record<string, string>,
    owner: string,
    repo: string,
    branch: string,
    perPage?: number,
  ): Promise<Array<{ sha: string; message: string; author: string; date: string }>> {
    const token = config.token;
    if (!token) return [];
    return gh.getBranchCommits(token, owner, repo, branch, perPage);
  }

  override async getDefaultBranch(
    config: Record<string, string>,
    owner: string,
    repo: string,
  ): Promise<string> {
    const token = config.token;
    if (!token) return "main";
    return gh.getDefaultBranch(token, owner, repo);
  }
}
