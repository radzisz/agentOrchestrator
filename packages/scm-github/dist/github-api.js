// ---------------------------------------------------------------------------
// GitHub REST API client — pure API layer, no storage dependencies
// ---------------------------------------------------------------------------
const GITHUB_API = "https://api.github.com";
async function ghFetch(token, path, options) {
    const resp = await fetch(`${GITHUB_API}${path}`, Object.assign(Object.assign({}, options), { headers: Object.assign({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, options === null || options === void 0 ? void 0 : options.headers) }));
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`GitHub API ${resp.status}: ${body}`);
    }
    return resp.json();
}
export function parseRepoUrl(url) {
    const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match)
        return null;
    return { owner: match[1], repo: match[2] };
}
export async function listBranches(token, owner, repo, mainBranch = "main") {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    const branches = await ghFetch(token, `/repos/${owner}/${repo}/branches?per_page=100`);
    const prs = await ghFetch(token, `/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
    const prByBranch = new Map();
    for (const pr of prs) {
        prByBranch.set(pr.head.ref, pr);
    }
    const results = [];
    for (const branch of branches) {
        if (branch.name === mainBranch || branch.name === "production")
            continue;
        let commitInfo;
        try {
            commitInfo = await ghFetch(token, `/repos/${owner}/${repo}/commits/${branch.commit.sha}`);
        }
        catch (_p) {
            continue;
        }
        let aheadBy = 0;
        let behindBy = 0;
        try {
            const comparison = await ghFetch(token, `/repos/${owner}/${repo}/compare/${mainBranch}...${branch.name}`);
            aheadBy = (_a = comparison.ahead_by) !== null && _a !== void 0 ? _a : 0;
            behindBy = (_b = comparison.behind_by) !== null && _b !== void 0 ? _b : 0;
        }
        catch (_q) { }
        const pr = prByBranch.get(branch.name);
        results.push({
            name: branch.name,
            commit: {
                sha: branch.commit.sha,
                message: (_e = (_d = (_c = commitInfo.commit) === null || _c === void 0 ? void 0 : _c.message) === null || _d === void 0 ? void 0 : _d.split("\n")[0]) !== null && _e !== void 0 ? _e : "",
                author: (_k = (_h = (_g = (_f = commitInfo.commit) === null || _f === void 0 ? void 0 : _f.author) === null || _g === void 0 ? void 0 : _g.name) !== null && _h !== void 0 ? _h : (_j = commitInfo.author) === null || _j === void 0 ? void 0 : _j.login) !== null && _k !== void 0 ? _k : "",
                date: (_o = (_m = (_l = commitInfo.commit) === null || _l === void 0 ? void 0 : _l.author) === null || _m === void 0 ? void 0 : _m.date) !== null && _o !== void 0 ? _o : "",
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
    results.sort((a, b) => new Date(b.commit.date).getTime() - new Date(a.commit.date).getTime());
    return results;
}
export async function createPullRequest(token, owner, repo, options) {
    var _a;
    const pr = await ghFetch(token, `/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title: options.title,
            body: options.body || "",
            head: options.head,
            base: options.base || "main",
            draft: (_a = options.draft) !== null && _a !== void 0 ? _a : false,
        }),
    });
    return { number: pr.number, url: pr.html_url };
}
export async function getBranchCommits(token, owner, repo, branch, perPage = 10) {
    const commits = await ghFetch(token, `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`);
    return commits.map((c) => {
        var _a, _b, _c, _d, _e, _f;
        return ({
            sha: c.sha,
            message: c.commit.message.split("\n")[0],
            author: (_d = (_b = (_a = c.commit.author) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : (_c = c.author) === null || _c === void 0 ? void 0 : _c.login) !== null && _d !== void 0 ? _d : "",
            date: (_f = (_e = c.commit.author) === null || _e === void 0 ? void 0 : _e.date) !== null && _f !== void 0 ? _f : "",
        });
    });
}
export async function getDefaultBranch(token, owner, repo) {
    var _a;
    const repoInfo = await ghFetch(token, `/repos/${owner}/${repo}`);
    return (_a = repoInfo.default_branch) !== null && _a !== void 0 ? _a : "main";
}
//# sourceMappingURL=github-api.js.map