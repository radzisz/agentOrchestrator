import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubSCMProvider, githubSchema, parseRepoUrl } from "../index.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function ghResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe("GitHubSCMProvider", () => {
  let provider: GitHubSCMProvider;

  beforeEach(() => {
    provider = new GitHubSCMProvider();
    mockFetch.mockReset();
  });

  it("has correct metadata", () => {
    expect(provider.name).toBe("github");
    expect(provider.schema.category).toBe("scm");
    expect(provider.schema.displayName).toBe("GitHub");
  });

  it("schema has token field", () => {
    const tokenField = githubSchema.fields.find((f) => f.key === "token");
    expect(tokenField).toBeDefined();
    expect(tokenField!.type).toBe("secret");
    expect(tokenField!.required).toBe(true);
  });

  describe("listBranches", () => {
    it("returns empty when no token", async () => {
      const result = await provider.listBranches({}, "owner", "repo", "main");
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fetches branches, PRs, commits, and comparisons", async () => {
      // branches
      mockFetch.mockResolvedValueOnce(ghResponse([
        { name: "feature-1", commit: { sha: "abc123" } },
        { name: "main", commit: { sha: "def456" } },
      ]));
      // PRs
      mockFetch.mockResolvedValueOnce(ghResponse([
        { head: { ref: "feature-1" }, number: 42, title: "Add feature", state: "open", html_url: "https://github.com/o/r/pull/42" },
      ]));
      // commit info for feature-1
      mockFetch.mockResolvedValueOnce(ghResponse({
        commit: { message: "feat: add stuff\n\nMore details", author: { name: "Dev", date: "2026-01-15T10:00:00Z" } },
        author: { login: "dev" },
      }));
      // comparison for feature-1
      mockFetch.mockResolvedValueOnce(ghResponse({ ahead_by: 3, behind_by: 1 }));

      const result = await provider.listBranches({ token: "ghp_test" }, "owner", "repo", "main");

      expect(result).toHaveLength(1); // main is skipped
      expect(result[0].name).toBe("feature-1");
      expect(result[0].commit.sha).toBe("abc123");
      expect(result[0].commit.message).toBe("feat: add stuff");
      expect(result[0].commit.author).toBe("Dev");
      expect(result[0].aheadBy).toBe(3);
      expect(result[0].behindBy).toBe(1);
      expect(result[0].pullRequest).toEqual({
        number: 42,
        title: "Add feature",
        state: "open",
        url: "https://github.com/o/r/pull/42",
      });
    });

    it("skips production branch", async () => {
      mockFetch.mockResolvedValueOnce(ghResponse([
        { name: "production", commit: { sha: "abc" } },
        { name: "feature", commit: { sha: "def" } },
      ]));
      mockFetch.mockResolvedValueOnce(ghResponse([])); // PRs
      mockFetch.mockResolvedValueOnce(ghResponse({
        commit: { message: "msg", author: { name: "A", date: "2026-01-01T00:00:00Z" } },
      }));
      mockFetch.mockResolvedValueOnce(ghResponse({ ahead_by: 0, behind_by: 0 }));

      const result = await provider.listBranches({ token: "t" }, "o", "r", "main");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("feature");
    });

    it("sets pullRequest to null for branches without PR", async () => {
      mockFetch.mockResolvedValueOnce(ghResponse([
        { name: "no-pr-branch", commit: { sha: "abc" } },
      ]));
      mockFetch.mockResolvedValueOnce(ghResponse([])); // no PRs
      mockFetch.mockResolvedValueOnce(ghResponse({
        commit: { message: "msg", author: { name: "A", date: "2026-01-01T00:00:00Z" } },
      }));
      mockFetch.mockResolvedValueOnce(ghResponse({ ahead_by: 0, behind_by: 0 }));

      const result = await provider.listBranches({ token: "t" }, "o", "r", "main");
      expect(result[0].pullRequest).toBeNull();
    });

    it("sends Authorization header", async () => {
      mockFetch.mockResolvedValueOnce(ghResponse([]));
      mockFetch.mockResolvedValueOnce(ghResponse([]));

      await provider.listBranches({ token: "ghp_secret" }, "o", "r", "main");

      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer ghp_secret");
    });
  });

  describe("createPR", () => {
    it("throws when no token", async () => {
      await expect(
        provider.createPR!({}, "o", "r", "head", "base", "title", "body"),
      ).rejects.toThrow("GitHub token not configured");
    });

    it("creates a pull request", async () => {
      mockFetch.mockResolvedValue(ghResponse({
        number: 99,
        html_url: "https://github.com/o/r/pull/99",
      }));

      const result = await provider.createPR!(
        { token: "ghp_test" }, "owner", "repo", "feature", "main", "My PR", "Description",
      );

      expect(result).toEqual({ number: 99, url: "https://github.com/o/r/pull/99" });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.head).toBe("feature");
      expect(body.base).toBe("main");
      expect(body.title).toBe("My PR");
      expect(body.body).toBe("Description");
    });
  });

  describe("getBranchCommits", () => {
    it("returns empty when no token", async () => {
      const result = await provider.getBranchCommits!({}, "o", "r", "branch");
      expect(result).toEqual([]);
    });

    it("fetches and maps commits", async () => {
      mockFetch.mockResolvedValue(ghResponse([
        {
          sha: "abc123",
          commit: { message: "fix: bug\n\nDetails", author: { name: "Dev", date: "2026-01-01T00:00:00Z" } },
          author: { login: "dev" },
        },
        {
          sha: "def456",
          commit: { message: "feat: new thing", author: { name: "Other", date: "2026-01-02T00:00:00Z" } },
          author: { login: "other" },
        },
      ]));

      const result = await provider.getBranchCommits!({ token: "t" }, "o", "r", "feature", 5);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        sha: "abc123",
        message: "fix: bug",
        author: "Dev",
        date: "2026-01-01T00:00:00Z",
      });
    });
  });

  describe("getDefaultBranch", () => {
    it("returns 'main' when no token", async () => {
      const result = await provider.getDefaultBranch!({}, "o", "r");
      expect(result).toBe("main");
    });

    it("fetches default branch from API", async () => {
      mockFetch.mockResolvedValue(ghResponse({ default_branch: "develop" }));
      const result = await provider.getDefaultBranch!({ token: "t" }, "o", "r");
      expect(result).toBe("develop");
    });
  });
});

describe("parseRepoUrl", () => {
  it("parses HTTPS URLs", () => {
    expect(parseRepoUrl("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses SSH URLs", () => {
    expect(parseRepoUrl("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("strips .git suffix", () => {
    expect(parseRepoUrl("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseRepoUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(parseRepoUrl("not-a-url")).toBeNull();
  });
});
