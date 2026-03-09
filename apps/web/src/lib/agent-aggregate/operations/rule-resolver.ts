// ---------------------------------------------------------------------------
// Rule resolver — merge global + project AI rules, write RULES.md
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { AIRule } from "@/lib/store";

/**
 * Merge global + project rules, filter enabled, sort by order.
 */
export function resolveRules(
  globalRules: AIRule[],
  projectRules: AIRule[],
): AIRule[] {
  return [...globalRules, ...projectRules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.order - b.order);
}

/**
 * Format resolved rules into RULES.md content.
 * Each rule includes title, "when to use" hint, and content.
 */
export function formatRulesMarkdown(rules: AIRule[]): string {
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

/**
 * Write RULES.md to the agent's .10timesdev directory.
 * Returns true if any rules were written.
 */
export function writeRulesMd(agentDir: string, rules: AIRule[]): boolean {
  const resolved = rules.filter((r) => r.enabled).sort((a, b) => a.order - b.order);
  if (resolved.length === 0) return false;

  const content = formatRulesMarkdown(resolved);
  const dir = join(agentDir, ".10timesdev");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "RULES.md"), content, "utf-8");
  return true;
}
