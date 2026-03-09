// ---------------------------------------------------------------------------
// Google Gemini AI Provider (Gemini CLI)
// ---------------------------------------------------------------------------

import {
  BaseAIProvider,
  type AIProviderDriver,
  type ProviderTypeSchema,
} from "@orchestrator/contracts";

export const geminiSchema: ProviderTypeSchema = {
  type: "gemini",
  category: "ai",
  displayName: "Gemini",
  fields: [
    { key: "model", label: "Model", type: "select", default: "gemini-2.5-pro", options: [
      { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro" },
      { label: "Gemini 2.5 Flash", value: "gemini-2.5-flash" },
    ] },
  ],
};

function filterGeminiOutput(raw: string): string {
  if (!raw) return "";
  const lines = raw.split("\n").filter((line) => {
    // Strip timestamp-prefixed lines
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/.test(line)) return false;
    // Strip entrypoint/runtime logs
    if (line.includes("[entrypoint]")) return false;
    if (line.includes("[runtime]")) return false;
    // Strip empty box-drawing lines
    if (/^[\s│┌┐└┘─╭╮╰╯┤├]+$/.test(line)) return false;
    return true;
  });
  return lines.join("\n").trim();
}

export class GeminiProvider extends BaseAIProvider {
  readonly name = "gemini";
  readonly schema = geminiSchema;

  createDriver(config: Record<string, string>): AIProviderDriver {
    const model = config.model || "gemini-2.5-pro";
    return {
      processPattern: "gemini.*-p",
      outputLogPath: "/tmp/gemini-output.log",

      buildLaunchCommand(prompt: string): string {
        const escaped = prompt.replace(/'/g, "'\\''");
        return `gosu agent gemini -p --yes --model ${model} '${escaped}' 2>&1 | tee /tmp/gemini-output.log`;
      },

      buildEnvVars(_projectConfig: Record<string, string>, instanceConfig?: Record<string, string>): string[] {
        return [
          `GEMINI_API_KEY=${instanceConfig?.apiKey || process.env.GEMINI_API_KEY || ""}`,
        ];
      },

      filterOutput: filterGeminiOutput,
    };
  }
}
