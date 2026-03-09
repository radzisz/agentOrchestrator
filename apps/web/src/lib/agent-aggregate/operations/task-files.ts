// ---------------------------------------------------------------------------
// Task file helpers — TASK.md, CLAUDE.md, .gitignore entries
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, copyFileSync } from "fs";
import { join, extname } from "path";
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

// ---------------------------------------------------------------------------
// Local image copy — for CDM tasks with pasted screenshots
// ---------------------------------------------------------------------------

const LOCAL_IMAGE_RE = /!\[([^\]]*)\]\((\/api\/projects\/[^/]+\/tasks\/images\/(img-[^)]+))\)/g;

/**
 * Copy local CDM task images from tasks dir to agent images dir,
 * rewriting markdown paths to .10timesdev/images/{filename}.
 */
export function copyLocalImages(text: string, srcDir: string, destDir: string): string {
  if (!text) return text;

  const matches = [...text.matchAll(LOCAL_IMAGE_RE)];
  if (matches.length === 0) return text;

  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  let result = text;
  for (const match of matches) {
    const [full, alt, , filename] = match;
    const srcPath = join(srcDir, filename);
    if (!existsSync(srcPath)) continue;

    const destPath = join(destDir, filename);
    copyFileSync(srcPath, destPath);

    const localPath = `.10timesdev/images/${filename}`;
    result = result.replace(full, `![${alt}](${localPath})`);
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

export async function writeTaskMd(agentDir: string, issue: TrackerIssue, opts?: { linearApiKey?: string; projectPath?: string }): Promise<void> {
  const imagesDir = join(agentDir, ".10timesdev", "images");
  const authHeaders = opts?.linearApiKey ? { Authorization: opts.linearApiKey } : undefined;

  // For local source issues with CDM task images, copy from tasks dir (title + description)
  let titleText = issue.title;
  let descText = issue.description || "";
  if (issue.source === "local" && opts?.projectPath) {
    const tasksImgDir = join(opts.projectPath, ".10timesdev", "tasks");
    titleText = copyLocalImages(titleText, tasksImgDir, imagesDir);
    descText = copyLocalImages(descText, tasksImgDir, imagesDir);
  }

  // Download remote images from title, description and comments
  titleText = await downloadImages(titleText, imagesDir, authHeaders);
  const description = await downloadImages(descText, imagesDir, authHeaders);

  let content = `# ${issue.identifier}: ${titleText}\n\n`;
  if (description) {
    content += `${description}\n\n`;
  }

  // Include human comments (with their inline images)
  if (issue.comments && issue.comments.length > 0) {
    content += "## Comments\n";
    for (const c of issue.comments) {
      const date = new Date(c.createdAt).toLocaleString();
      const body = await downloadImages(c.body, imagesDir, authHeaders);
      content += `\n### ${c.authorName} (${date})\n\n${body}\n`;
    }
  }

  const dir = join(agentDir, ".10timesdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TASK.md"), content, "utf-8");
}

export function writeClaudeMd(ctx: AggregateContext, agentDir: string, defaultBranch = "main", hasRules = false): void {
  // Check for README
  let readmeHint = "";
  for (const name of ["README.md", "readme.md", "README", "README.txt"]) {
    if (existsSync(join(agentDir, name))) {
      readmeHint = `\nStart by reading \`${name}\` to understand the project structure, conventions, and development workflow.\n`;
      break;
    }
  }

  const rulesSection = hasRules ? `
## AI Rules

Read \`.10timesdev/RULES.md\`. It contains project-specific and global rules.
For each rule, check the "When to use" description. Apply the rule ONLY if
the condition matches your current task and the code you are modifying.
Skip rules whose conditions do not apply.
` : "";

  const content = `# Agent Instructions

## Task

Read \`.10timesdev/TASK.md\`. This is your task.
Work ONLY on this task. Do not go beyond scope.
${readmeHint}
## Git — allowed operations

You may ONLY use these git commands:

\`\`\`bash
# Commit your changes (use descriptive message):
git add <files>
git commit -m "🟢 [${ctx.issueId}] description of change"

# Rebase onto main (if instructed to do so):
git rebase ${defaultBranch}
\`\`\`

Do NOT push. Do NOT run git fetch. The orchestrator handles push and sync.
${rulesSection}
## When done

If your work is complete and all changes are correct:

1. **Commit** all your changes with a clear, descriptive message:
   \`\`\`bash
   git add <files>
   git commit -m "🟢 [${ctx.issueId}] descriptive summary of what was done"
   \`\`\`

2. **Output** a JSON block as your **final message**:
   \`\`\`json
   {
     "status": "done",
     "description": "Brief summary of what was changed and why"
   }
   \`\`\`

If you need more information from the user (do NOT commit):

\`\`\`json
{
  "status": "more_information_required",
  "description": "What information you need and why"
}
\`\`\`

If you encountered an unrecoverable error (do NOT commit):

\`\`\`json
{
  "status": "error",
  "description": "What went wrong"
}
\`\`\`

Do nothing else after outputting the JSON.
`;
  const dir = join(agentDir, ".10timesdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), content, "utf-8");
}
