// ---------------------------------------------------------------------------
// GitHub REST API client — pure API layer, no storage dependencies
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";

async function ghFetch<T = any>(
  token: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const resp = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options?.headers,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${body}`);
  }

  return resp.json();
}

export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

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

export async function listBranches(
  token: string,
  owner: string,
  repo: string,
  mainBranch: string = "main",
): Promise<GHBranch[]> {
  const branches = await ghFetch<any[]>(
    token,
    `/repos/${owner}/${repo}/branches?per_page=100`,
  );

  const prs = await ghFetch<any[]>(
    token,
    `/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
  );
  const prByBranch = new Map<string, any>();
  for (const pr of prs) {
    prByBranch.set(pr.head.ref, pr);
  }

  const results: GHBranch[] = [];

  for (const branch of branches) {
    if (branch.name === mainBranch || branch.name === "production") continue;

    let commitInfo: any;
    try {
      commitInfo = await ghFetch(
        token,
        `/repos/${owner}/${repo}/commits/${branch.commit.sha}`,
      );
    } catch {
      continue;
    }

    let aheadBy = 0;
    let behindBy = 0;
    try {
      const comparison = await ghFetch(
        token,
        `/repos/${owner}/${repo}/compare/${mainBranch}...${branch.name}`,
      );
      aheadBy = comparison.ahead_by ?? 0;
      behindBy = comparison.behind_by ?? 0;
    } catch {}

    const pr = prByBranch.get(branch.name);

    results.push({
      name: branch.name,
      commit: {
        sha: branch.commit.sha,
        message: commitInfo.commit?.message?.split("\n")[0] ?? "",
        author: commitInfo.commit?.author?.name ?? commitInfo.author?.login ?? "",
        date: commitInfo.commit?.author?.date ?? "",
      },
      aheadBy,
      behindBy,
      pullRequest: pr
        ? {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            url: pr.html_url,
          }
        : null,
    });
  }

  results.sort(
    (a, b) => new Date(b.commit.date).getTime() - new Date(a.commit.date).getTime(),
  );

  return results;
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  options: {
    head: string;
    base?: string;
    title: string;
    body?: string;
    draft?: boolean;
  },
): Promise<{ number: number; url: string }> {
  const pr = await ghFetch<any>(token, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: options.title,
      body: options.body || "",
      head: options.head,
      base: options.base || "main",
      draft: options.draft ?? false,
    }),
  });

  return { number: pr.number, url: pr.html_url };
}

export async function getBranchCommits(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  perPage: number = 10,
): Promise<Array<{ sha: string; message: string; author: string; date: string }>> {
  const commits = await ghFetch<any[]>(
    token,
    `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`,
  );

  return commits.map((c) => ({
    sha: c.sha,
    message: c.commit.message.split("\n")[0],
    author: c.commit.author?.name ?? c.author?.login ?? "",
    date: c.commit.author?.date ?? "",
  }));
}

export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  const repoInfo = await ghFetch<any>(token, `/repos/${owner}/${repo}`);
  return repoInfo.default_branch ?? "main";
}
