// ---------------------------------------------------------------------------
// Task file helpers — TASK.md, CLAUDE.md, .gitignore entries
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "fs";
import { join, extname } from "path";
import type { PortInfo } from "@/lib/store";
import type { TrackerIssue } from "@/lib/issue-trackers/types";
import type { AggregateContext } from "../types";

// ---------------------------------------------------------------------------
// Image downloading — extract markdown images, download, rewrite paths
// ---------------------------------------------------------------------------

const MD_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;

/** Download all markdown images in text to imagesDir, return text with local paths. */
export async function downloadImages(
  text: string,
  imagesDir: string,
  authHeaders?: Record<string, string>,
): Promise<string> {
  if (!text) return text;

  const matches = [...text.matchAll(MD_IMAGE_RE)];
  if (matches.length === 0) return text;

  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });

  let result = text;
  let idx = 0;

  for (const match of matches) {
    const [full, alt, url] = match;
    idx++;
    try {
      // Use auth headers for Linear CDN (uploads.linear.app requires API key)
      const headers: Record<string, string> = {};
      if (url.includes("uploads.linear.app") && authHeaders?.Authorization) {
        headers.Authorization = authHeaders.Authorization;
      }
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) continue;

      const contentType = resp.headers.get("content-type") || "";
      let ext = ".png";
      if (contentType.includes("jpeg") || contentType.includes("jpg")) ext = ".jpg";
      else if (contentType.includes("gif")) ext = ".gif";
      else if (contentType.includes("webp")) ext = ".webp";
      else if (contentType.includes("svg")) ext = ".svg";
      else {
        // Try from URL
        const urlExt = extname(new URL(url).pathname).toLowerCase();
        if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(urlExt)) ext = urlExt;
      }

      const filename = `img-${idx}${ext}`;
      const buffer = Buffer.from(await resp.arrayBuffer());
      writeFileSync(join(imagesDir, filename), buffer);

      const localPath = `.10timesdev/images/${filename}`;
      result = result.replace(full, `![${alt}](${localPath})`);
    } catch {
      // Keep original URL on failure
    }
  }

  return result;
}

/**
 * Rewrite markdown image URLs to point to our API endpoint.
 * Uses the same img-N naming as downloadImages (counter shared via imagesDir scan).
 */
export function rewriteImageUrls(text: string, projectName: string, issueId: string, imagesDir: string): string {
  if (!text) return text;
  let result = text;
  let idx = 0;
  for (const match of text.matchAll(MD_IMAGE_RE)) {
    const [full, alt, url] = match;
    idx++;
    // Check if image was downloaded
    const candidates = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
    for (const ext of candidates) {
      const filename = `img-${idx}${ext}`;
      if (existsSync(join(imagesDir, filename))) {
        const apiPath = `/api/projects/${projectName}/agents/${issueId}/images/${filename}`;
        result = result.replace(full, `![${alt}](${apiPath})`);
        break;
      }
    }
  }
  return result;
}

export function ensureGitIgnored(agentDir: string, entries: string[]): void {
  const gitignorePath = join(agentDir, ".gitignore");
  let content = "";
  try { content = readFileSync(gitignorePath, "utf-8"); } catch {}
  const lines = content.split("\n");
  const missing = entries.filter(e => !lines.some(l => l.trim() === e));
  if (missing.length > 0) {
    const addition = (content.endsWith("\n") || content === "" ? "" : "\n")
      + "# 10timesdev orchestrator files\n"
      + missing.join("\n") + "\n";
    appendFileSync(gitignorePath, addition, "utf-8");
  }
}

export async function writeTaskMd(agentDir: string, issue: TrackerIssue, opts?: { linearApiKey?: string }): Promise<void> {
  const labels = issue.labels.join(", ");
  const imagesDir = join(agentDir, ".10timesdev", "images");
  const authHeaders = opts?.linearApiKey ? { Authorization: opts.linearApiKey } : undefined;

  // Download images from description and comments
  const description = await downloadImages(issue.description || "Brak opisu", imagesDir, authHeaders);

  let content = `# ${issue.identifier}: ${issue.title}\n\n## Opis\n\n${description}\n\n## Priorytet\n${issue.priority}\n\n## Labelki\n${labels}\n\n## Status\n${issue.rawState}\n\n## Source\n${issue.source}\n`;

  // Include human comments (with their inline images)
  if (issue.comments && issue.comments.length > 0) {
    content += "\n## Komentarze\n";
    for (const c of issue.comments) {
      const date = new Date(c.createdAt).toLocaleString();
      const body = await downloadImages(c.body, imagesDir, authHeaders);
      content += `\n### ${c.authorName} (${date})\n\n${body}\n`;
    }
  }

  // Include Linear URL for reference
  if (issue.url) {
    content += `\n## Link\n\n${issue.url}\n`;
  }

  const dir = join(agentDir, ".10timesdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TASK.md"), content, "utf-8");
}

export function writeClaudeMd(ctx: AggregateContext, agentDir: string, ports: PortInfo, defaultBranch = "main"): void {
  const content = `# Agent ${ctx.issueId} — ${ctx.projectName}

## Task

Read \`.10timesdev/TASK.md\`. This is your task.
Work ONLY on this task. Do not go beyond scope.

## Identity

- Issue: **${ctx.issueId}**
- Project: **${ctx.projectName}**
- Branch: \`agent/${ctx.issueId}\`
- Tracker: **${ctx.agent.trackerSource || "linear"}** (\`${ctx.agent.trackerExternalId || ctx.agent.linearIssueUuid || "N/A"}\`)

## Ports (ONLY these!)

| Service    | Port  |
|------------|-------|
| Dev server | ${ports.frontend[0]} |
| Service 2  | ${ports.frontend[1]} |
| Service 3  | ${ports.frontend[2]} |
| Backend 1  | ${ports.backend[0]} |
| Backend 2  | ${ports.backend[1]} |
| Backend 3  | ${ports.backend[2]} |

## Commit format

\`\`\`
🟢 [${ctx.issueId}] opis zmian
🟡 [${ctx.issueId}] opis zmian
\`\`\`

## Sync

\`\`\`bash
git fetch origin ${defaultBranch}
git rebase origin/${defaultBranch}
git push origin HEAD:agent/${ctx.issueId} --force-with-lease
\`\`\`

## Before finishing

Before pushing, verify the project builds without errors:

\`\`\`bash
npm run build 2>&1 | tail -30
\`\`\`

If there are TypeScript or build errors, fix them before pushing. Do NOT push code that doesn't compile.

## When done

1. Push to origin/agent/${ctx.issueId}
2. Comment on Linear
3. Do nothing else
`;
  const dir = join(agentDir, ".10timesdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), content, "utf-8");
}
