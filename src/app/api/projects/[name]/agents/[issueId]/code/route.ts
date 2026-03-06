import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import * as cmd from "@/lib/cmd";

export const dynamic = "force-dynamic";

const SRC = "code";

interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

interface ChangedFile {
  status: string;
  file: string;
  additions: number;
  deletions: number;
}

async function git(agentDir: string, args: string, timeout = 15000): Promise<string> {
  const r = await cmd.git(`-C "${agentDir}" ${args}`, { source: SRC, timeout });
  return r.ok ? r.stdout : "";
}

async function getDefaultBranch(agentDir: string): Promise<string> {
  const ref = await git(agentDir, "symbolic-ref refs/remotes/origin/HEAD");
  if (ref) return ref.replace("refs/remotes/origin/", "");
  const branches = await git(agentDir, "branch -r");
  if (branches.includes("origin/main")) return "main";
  return "master";
}

async function resolveRefs(agentDir: string, agentBranch?: string): Promise<{ base: string; head: string }> {
  const defaultBranch = await getDefaultBranch(agentDir);
  // Prefer origin/{agentBranch} over HEAD — HEAD may point to the wrong branch
  // if the agent dir hasn't checked out the agent branch
  let head = "HEAD";
  if (agentBranch) {
    const refExists = await git(agentDir, `rev-parse --verify "origin/${agentBranch}" 2>/dev/null`);
    if (refExists) head = `origin/${agentBranch}`;
  }
  return { base: `origin/${defaultBranch}`, head };
}

async function getFilesForCommits(
  agentDir: string,
  commitHashes: string[]
): Promise<{ changedFiles: ChangedFile[]; summary: string }> {
  const fileMap = new Map<string, { status: string; additions: number; deletions: number }>();

  const results = await Promise.all(
    commitHashes.map(async (hash) => ({
      numstat: await git(agentDir, `diff-tree --no-commit-id -r --numstat "${hash}"`),
      nameStatus: await git(agentDir, `diff-tree --no-commit-id -r --name-status "${hash}"`),
    }))
  );

  for (const { numstat, nameStatus } of results) {
    const statusMap = new Map<string, string>();
    if (nameStatus) {
      for (const line of nameStatus.split("\n")) {
        const parts = line.split("\t");
        const s = parts[0]?.[0] || "M";
        const f = parts[parts.length - 1];
        if (f) statusMap.set(f, s);
      }
    }

    if (numstat) {
      for (const line of numstat.split("\n")) {
        const [add, del, fileName] = line.split("\t");
        if (!fileName) continue;
        const existing = fileMap.get(fileName);
        if (existing) {
          existing.additions += parseInt(add) || 0;
          existing.deletions += parseInt(del) || 0;
        } else {
          fileMap.set(fileName, {
            status: statusMap.get(fileName) || "M",
            additions: parseInt(add) || 0,
            deletions: parseInt(del) || 0,
          });
        }
      }
    }
  }

  const changedFiles: ChangedFile[] = [];
  for (const [file, info] of fileMap) {
    changedFiles.push({ file, ...info });
  }

  const totalFiles = changedFiles.length;
  const totalAdd = changedFiles.reduce((s, f) => s + f.additions, 0);
  const totalDel = changedFiles.reduce((s, f) => s + f.deletions, 0);
  const summary = totalFiles > 0
    ? `${totalFiles} file${totalFiles !== 1 ? "s" : ""} changed, ${totalAdd} insertions(+), ${totalDel} deletions(-)`
    : "";

  return { changedFiles, summary };
}

async function getDiffForCommits(
  agentDir: string,
  commitHashes: string[],
  file: string,
  full = false
): Promise<string> {
  const diffFlag = full ? "-U999999" : "";
  const results = await Promise.all(
    commitHashes.map((hash) => git(agentDir, `show ${diffFlag} "${hash}" --format="" -- "${file}"`))
  );
  return results.filter(Boolean).join("\n") || "No changes";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string; issueId: string }> }
) {
  const { name, issueId } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const agent = store.getAgent(project.path, issueId);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const agentDir = agent.agentDir;
  if (!agentDir) {
    return NextResponse.json({ error: "Agent has no directory" }, { status: 404 });
  }

  // Fetch origin (non-fatal)
  await git(agentDir, "fetch origin 2>&1", 30000);

  const { base, head } = await resolveRefs(agentDir, agent.branch);

  // Parse optional commits filter
  const commitsParam = req.nextUrl.searchParams.get("commits");
  const selectedCommits = commitsParam ? commitsParam.split(",").filter(Boolean) : null;

  // File diff request
  const file = req.nextUrl.searchParams.get("file");
  if (file) {
    const full = req.nextUrl.searchParams.get("full") === "1";
    const diffFlag = full ? "-U999999" : "";
    let diff: string;
    if (selectedCommits) {
      diff = await getDiffForCommits(agentDir, selectedCommits, file, full);
    } else {
      diff = await git(agentDir, `diff ${diffFlag} "${base}" "${head}" -- "${file}"`);
    }
    return NextResponse.json({ diff: diff || "No changes" });
  }

  try {
    const defaultBranch = await getDefaultBranch(agentDir);
    const currentBranch = agent.branch || await git(agentDir, "branch --show-current") || "";

    const [commitsRaw, numstatRaw, nameStatusRaw, diffStat] = await Promise.all([
      git(agentDir, `log --format="%H|%s|%an|%ci" "${base}..${head}" --`),
      selectedCommits ? Promise.resolve("") : git(agentDir, `diff --numstat "${base}" "${head}"`),
      selectedCommits ? Promise.resolve("") : git(agentDir, `diff --name-status "${base}" "${head}"`),
      selectedCommits ? Promise.resolve("") : git(agentDir, `diff --stat "${base}" "${head}"`),
    ]);

    const commits: CommitInfo[] = commitsRaw
      ? commitsRaw.split("\n").map((line) => {
          const [hash, message, author, date] = line.split("|");
          return { hash, message, author, date };
        })
      : [];

    let changedFiles: ChangedFile[];
    let summary: string;

    if (selectedCommits) {
      const result = await getFilesForCommits(agentDir, selectedCommits);
      changedFiles = result.changedFiles;
      summary = result.summary;
    } else {
      const statusMap = new Map<string, string>();
      if (nameStatusRaw) {
        for (const line of nameStatusRaw.split("\n")) {
          const parts = line.split("\t");
          const status = parts[0]?.[0] || "M";
          const fileName = parts[parts.length - 1];
          if (fileName) statusMap.set(fileName, status);
        }
      }

      changedFiles = [];
      if (numstatRaw) {
        for (const line of numstatRaw.split("\n")) {
          const [add, del, fileName] = line.split("\t");
          if (!fileName) continue;
          changedFiles.push({
            status: statusMap.get(fileName) || "M",
            file: fileName,
            additions: parseInt(add) || 0,
            deletions: parseInt(del) || 0,
          });
        }
      }

      summary = diffStat.split("\n").pop() || "";
    }

    const [mergeBase, baseSha] = await Promise.all([
      git(agentDir, `merge-base "${base}" "${head}"`),
      git(agentDir, `rev-parse "${base}"`),
    ]);
    let mainAhead = 0;
    if (mergeBase && baseSha && mergeBase !== baseSha) {
      const count = await git(agentDir, `rev-list --count "${mergeBase}..${base}"`);
      mainAhead = parseInt(count) || 0;
    }

    let allDiffs: Record<string, string> | undefined;
    let allFullDiffs: Record<string, string> | undefined;
    const prefetch = req.nextUrl.searchParams.get("prefetch") === "1";
    if (prefetch && changedFiles.length > 0 && changedFiles.length <= 50) {
      const results = await Promise.all(
        changedFiles.map(async (f) => {
          let compact: string;
          let full: string;
          if (selectedCommits) {
            [compact, full] = await Promise.all([
              getDiffForCommits(agentDir, selectedCommits, f.file, false),
              getDiffForCommits(agentDir, selectedCommits, f.file, true),
            ]);
          } else {
            [compact, full] = await Promise.all([
              git(agentDir, `diff "${base}" "${head}" -- "${f.file}"`),
              git(agentDir, `diff -U999999 "${base}" "${head}" -- "${f.file}"`),
            ]);
          }
          return { file: f.file, compact: compact || "No changes", full: full || "No changes" };
        })
      );
      allDiffs = Object.fromEntries(results.map(r => [r.file, r.compact]));
      allFullDiffs = Object.fromEntries(results.map(r => [r.file, r.full]));
    }

    return NextResponse.json({
      branch: currentBranch,
      baseBranch: defaultBranch,
      commits,
      changedFiles,
      summary,
      mainAhead,
      ...(allDiffs ? { diffs: allDiffs, fullDiffs: allFullDiffs } : {}),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
