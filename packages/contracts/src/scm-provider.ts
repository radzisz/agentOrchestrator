// ---------------------------------------------------------------------------
// SCM Provider contract — abstract base class for source control integrations
// ---------------------------------------------------------------------------

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

export abstract class BaseSCMProvider {
  abstract readonly name: string;
  abstract readonly schema: ProviderTypeSchema;

  abstract listBranches(
    config: Record<string, string>,
    owner: string,
    repo: string,
    mainBranch: string,
  ): Promise<SCMBranch[]>;

  async createPR?(
    config: Record<string, string>,
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string }>;

  async getBranchCommits?(
    config: Record<string, string>,
    owner: string,
    repo: string,
    branch: string,
    perPage?: number,
  ): Promise<Array<{ sha: string; message: string; author: string; date: string }>>;

  async getDefaultBranch?(
    config: Record<string, string>,
    owner: string,
    repo: string,
  ): Promise<string>;
}
