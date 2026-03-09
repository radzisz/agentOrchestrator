// ---------------------------------------------------------------------------
// Conversation aggregate — single source of truth for agent ↔ human dialogue.
//
// Owns:
//   • messages.jsonl  (persistent conversation log for UI)
//   • TASK.md         (rebuilt before every agent launch — original task + full dialogue)
//   • CLAUDE.md       (regenerated before every agent launch)
//   • RULES.md        (regenerated before every agent launch)
//
// Invariant: TASK.md always reflects the full conversation from messages.jsonl.
// We never append — we overwrite TASK.md from scratch each time.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import type * as store from "@/lib/store";
import type { TrackerIssue } from "@/lib/issue-trackers/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "human" | "agent";
  text: string;
  ts: string;
}

export interface ConversationDeps {
  /** Read all messages from persistent store. */
  getMessages(projectPath: string, issueId: string): ChatMessage[];
  /** Append a single message to persistent store. */
  appendMessage(projectPath: string, issueId: string, role: "human" | "agent", text: string): void;
  /** Delete a message by index and rewrite the file. */
  deleteMessage(projectPath: string, issueId: string, index: number): void;
  /** Read global AI rules. */
  getAIRules(): store.AIRule[];
  /** Read project config (for project-level AI_RULES). */
  getProjectConfig(projectPath: string): Record<string, string>;
}

export interface TaskContext {
  issueId: string;
  projectName: string;
  projectPath: string;
  agentDir: string;
  title: string;
  description?: string;
  trackerIssue?: TrackerIssue;
  defaultBranch: string;
  ports: store.PortInfo;
}

// ---------------------------------------------------------------------------
// Conversation Aggregate
// ---------------------------------------------------------------------------

export class ConversationAggregate {
  private readonly ctx: TaskContext;
  private readonly deps: ConversationDeps;

  constructor(ctx: TaskContext, deps: ConversationDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  // -----------------------------------------------------------------------
  // Read
  // -----------------------------------------------------------------------

  /** Get a snapshot of the full conversation. */
  getMessages(): ChatMessage[] {
    return this.deps.getMessages(this.ctx.projectPath, this.ctx.issueId);
  }

  // -----------------------------------------------------------------------
  // Write — mutate conversation
  // -----------------------------------------------------------------------

  /** Record a human message in the conversation log. */
  addHumanMessage(text: string): void {
    if (!text.trim()) return;
    this.deps.appendMessage(this.ctx.projectPath, this.ctx.issueId, "human", text);
  }

  /** Record an agent response in the conversation log. */
  addAgentResponse(text: string): void {
    if (!text.trim()) return;
    this.deps.appendMessage(this.ctx.projectPath, this.ctx.issueId, "agent", text);
  }

  /** Delete a message by index. Returns the remaining messages. */
  deleteMessage(index: number): ChatMessage[] {
    this.deps.deleteMessage(this.ctx.projectPath, this.ctx.issueId, index);
    return this.getMessages();
  }

  // -----------------------------------------------------------------------
  // File generation — rebuild *.md files from conversation state
  // -----------------------------------------------------------------------

  /** Rebuild TASK.md from the original task + full conversation history. */
  rebuildTaskMd(): string {
    const messages = this.getMessages();
    const content = buildTaskMd(this.ctx, messages);
    this.writeTenxFile("TASK.md", content);
    return content;
  }

  /** Rebuild CLAUDE.md with current context. */
  rebuildClaudeMd(hasRules: boolean): string {
    const content = buildClaudeMd(this.ctx, hasRules);
    this.writeTenxFile("CLAUDE.md", content);
    return content;
  }

  /** Rebuild RULES.md from global + project rules. Returns true if rules were written. */
  rebuildRulesMd(): boolean {
    const globalRules = this.deps.getAIRules();
    const projectConfig = this.deps.getProjectConfig(this.ctx.projectPath);
    const projectRules: store.AIRule[] = JSON.parse(projectConfig.AI_RULES || "[]");
    const allRules = [...globalRules, ...projectRules]
      .filter((r) => r.enabled)
      .sort((a, b) => a.order - b.order);

    if (allRules.length === 0) return false;

    const content = buildRulesMd(allRules);
    this.writeTenxFile("RULES.md", content);
    return true;
  }

  /**
   * Prepare all files before launching the agent.
   * Call this before every `startAgentProcess()`.
   * Returns the prompt string to pass to the agent.
   */
  prepareForLaunch(opts?: { newMessage?: string }): string {
    // 1. Record new human message if provided
    if (opts?.newMessage) {
      this.addHumanMessage(opts.newMessage);
    }

    // 2. Rebuild all files
    const hasRules = this.rebuildRulesMd();
    this.rebuildClaudeMd(hasRules);
    this.rebuildTaskMd();

    // 3. Choose prompt based on conversation state
    return this.buildPrompt(opts?.newMessage);
  }

  /**
   * Handle agent exit — record the filtered output.
   * Call this from onExit callback after filtering.
   */
  recordAgentExit(filteredOutput: string): void {
    if (!filteredOutput.trim()) return;
    const tail = filteredOutput.split("\n").slice(-50).join("\n");
    this.addAgentResponse(tail);
  }

  // -----------------------------------------------------------------------
  // Prompt selection
  // -----------------------------------------------------------------------

  private buildPrompt(newMessage?: string): string {
    const messages = this.getMessages();
    const hasConversation = messages.length > 1; // more than just the initial task

    if (newMessage) {
      return "Read .10timesdev/TASK.md — it contains your task and the full conversation history including NEW INSTRUCTIONS at the end. " +
        "Read .10timesdev/CLAUDE.md for rules and response format. " +
        "Apply the changes according to the latest instructions. " +
        "When done, output the JSON response as described in CLAUDE.md.";
    }

    if (hasConversation) {
      return "Read .10timesdev/TASK.md — it contains your task and the full conversation history. " +
        "Read .10timesdev/CLAUDE.md for rules and response format. " +
        "Continue working on the task. When done, output the JSON response as described in CLAUDE.md.";
    }

    return "Read .10timesdev/TASK.md — this is your task. " +
      "Read .10timesdev/CLAUDE.md — it contains your identity, rules, allowed git operations, and response format. " +
      "Complete the task. When done, output the JSON response as described in CLAUDE.md.";
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private writeTenxFile(filename: string, content: string): void {
    const dir = join(this.ctx.agentDir, ".10timesdev");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Pure builders — generate markdown content (no I/O, easily testable)
// ---------------------------------------------------------------------------

/** Build TASK.md content from task context + conversation messages. */
export function buildTaskMd(ctx: TaskContext, messages: ChatMessage[]): string {
  const issue = ctx.trackerIssue;
  let content = `# ${ctx.issueId}: ${ctx.title}\n\n`;

  // Description
  const desc = ctx.description || issue?.description;
  if (desc) {
    content += `## Opis\n\n${desc}\n\n`;
  }

  // Attachments — list downloaded files from .10timesdev/images/
  const imagesDir = join(ctx.agentDir, ".10timesdev", "images");
  if (existsSync(imagesDir)) {
    const { readdirSync } = require("fs");
    const files = (readdirSync(imagesDir) as string[]).filter((f: string) => !f.startsWith("."));
    if (files.length > 0) {
      content += `## Załączniki\n\n`;
      for (const f of files) {
        content += `- \`.10timesdev/images/${f}\`\n`;
      }
      content += "\n";
    }
  }

  // Metadata from tracker issue
  if (issue) {
    const labels = issue.labels?.join(", ") || "";
    content += `## Priorytet\n${issue.priority}\n\n`;
    content += `## Labelki\n${labels}\n\n`;
    content += `## Status\n${issue.rawState}\n\n`;
    content += `## Source\n${issue.source}\n`;

    if (issue.url) {
      content += `\n## Link\n\n${issue.url}\n`;
    }
  }

  // Conversation history — skip the first human message (it's the initial task,
  // already represented by the title/description above)
  const conversationMessages = messages.slice(1);
  if (conversationMessages.length > 0) {
    content += "\n---\n\n## Conversation history\n";

    for (const msg of conversationMessages) {
      const text = rewriteApiUrlsToLocal(msg.text);
      if (msg.role === "human") {
        content += `\n### Human\n\n${text}\n`;
      } else {
        content += `\n### Agent\n\n${text}\n`;
      }
    }
  }

  return content;
}

/**
 * Rewrite API image/file URLs to local paths the agent can access.
 *
 * messages.jsonl stores URLs like `/api/projects/P/agents/X/images/img-1.png`
 * (for browser display). The agent needs `.10timesdev/images/img-1.png`.
 */
export function rewriteApiUrlsToLocal(text: string): string {
  if (!text) return text;
  return text
    // /api/projects/P/agents/X/images/FILE → .10timesdev/images/FILE
    .replace(/\/api\/projects\/[^/]+\/agents\/[^/]+\/images\/([^\s)]+)/g, ".10timesdev/images/$1")
    // /api/projects/P/tasks/images/FILE → .10timesdev/images/FILE
    .replace(/\/api\/projects\/[^/]+\/tasks\/images\/([^\s)]+)/g, ".10timesdev/images/$1");
}

/** Build CLAUDE.md content. */
export function buildClaudeMd(ctx: TaskContext, hasRules: boolean): string {
  // Detect package manager
  let buildCmd = "npm run build";
  if (existsSync(join(ctx.agentDir, "pnpm-lock.yaml")) || existsSync(join(ctx.agentDir, "pnpm-workspace.yaml"))) {
    buildCmd = "pnpm run build";
  } else if (existsSync(join(ctx.agentDir, "bun.lockb"))) {
    buildCmd = "bun run build";
  } else if (existsSync(join(ctx.agentDir, "yarn.lock"))) {
    buildCmd = "yarn build";
  }

  const rulesSection = hasRules ? `
## AI Rules

Read \`.10timesdev/RULES.md\`. It contains project-specific and global rules.
For each rule, check the "When to use" description. Apply the rule ONLY if
the condition matches your current task and the code you are modifying.
Skip rules whose conditions do not apply.
` : "";

  return `# Agent ${ctx.issueId} — ${ctx.projectName}

## Task

Read \`.10timesdev/TASK.md\`. This is your task and conversation history.
Work ONLY on this task. Do not go beyond scope.

## Identity

- Issue: **${ctx.issueId}**
- Project: **${ctx.projectName}**
- Branch: \`agent/${ctx.issueId}\`

## Ports (ONLY these!)

| Service    | Port  |
|------------|-------|
| Dev server | ${ctx.ports.frontend[0]} |
| Service 2  | ${ctx.ports.frontend[1]} |
| Service 3  | ${ctx.ports.frontend[2]} |
| Backend 1  | ${ctx.ports.backend[0]} |
| Backend 2  | ${ctx.ports.backend[1]} |
| Backend 3  | ${ctx.ports.backend[2]} |

## Git — allowed operations

You may ONLY use these git commands:

\`\`\`bash
# Commit your changes (use descriptive message):
git add <files>
git commit -m "🟢 [${ctx.issueId}] description of change"

# Rebase onto main (if instructed to do so):
git rebase ${ctx.defaultBranch}
\`\`\`

Do NOT push. Do NOT run git fetch. The orchestrator handles push and sync.

## Before finishing

Verify the project builds without errors:

\`\`\`bash
${buildCmd} 2>&1 | tail -30
\`\`\`

If there are TypeScript or build errors, fix them before committing. Do NOT commit code that doesn't compile.
${rulesSection}
## When done

When you finish your work, output a JSON block as your **final message**:

\`\`\`json
{
  "status": "done",
  "description": "Brief summary of what was changed and why"
}
\`\`\`

If you need more information from the user to proceed:

\`\`\`json
{
  "status": "more_information_required",
  "description": "What information you need and why"
}
\`\`\`

If you encountered an unrecoverable error:

\`\`\`json
{
  "status": "error",
  "description": "What went wrong"
}
\`\`\`

Do nothing else after outputting the JSON.
`;
}

/** Build RULES.md content from sorted, enabled rules. */
export function buildRulesMd(rules: store.AIRule[]): string {
  if (rules.length === 0) return "";

  const sections = rules.map((r, i) => {
    const whenLine = r.whenToUse ? `**When to use:** ${r.whenToUse}\n\n` : "";
    return `### ${i + 1}. ${r.title}\n\n${whenLine}${r.content}`;
  });

  return `# AI Rules

Read through the rules below. For each rule, check the "When to use" description and decide whether it applies to your current task and codebase. Apply all rules that are relevant.

${sections.join("\n\n---\n\n")}
`;
}
