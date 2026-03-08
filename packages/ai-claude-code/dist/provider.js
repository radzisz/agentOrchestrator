// ---------------------------------------------------------------------------
// Claude Code AI Provider
// ---------------------------------------------------------------------------
import { BaseAIProvider, } from "@orchestrator/contracts";
export const claudeCodeSchema = {
    type: "claude-code",
    category: "ai",
    displayName: "Claude Code",
    fields: [
        { key: "model", label: "Model", type: "select", default: "sonnet", options: [
                { label: "Sonnet", value: "sonnet" },
                { label: "Opus", value: "opus" },
                { label: "Haiku", value: "haiku" },
            ] },
    ],
};
function filterClaudeOutput(raw) {
    if (!raw)
        return "";
    const lines = raw.split("\n").filter((line) => {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/.test(line))
            return false;
        if (line.includes("[entrypoint]"))
            return false;
        if (line.includes("[runtime]"))
            return false;
        if (line.includes("node --trace-warnings"))
            return false;
        if (line.includes("Unable to open browser automatically"))
            return false;
        if (line.includes("Starting framework dev server"))
            return false;
        if (line.includes("Local dev server ready"))
            return false;
        if (line.includes("Waiting for framework dev server"))
            return false;
        if (/^[\s│┌┐└┘─╭╮╰╯┤├]+$/.test(line))
            return false;
        return true;
    });
    return lines.join("\n").trim();
}
export class ClaudeCodeProvider extends BaseAIProvider {
    constructor() {
        super(...arguments);
        this.name = "claude-code";
        this.schema = claudeCodeSchema;
    }
    createDriver(config) {
        const model = config.model || "sonnet";
        return {
            processPattern: "claude.*--dangerously-skip-permissions",
            outputLogPath: "/tmp/claude-output.log",
            buildLaunchCommand(prompt) {
                const escaped = prompt.replace(/'/g, "'\\''");
                return `gosu agent claude -p --dangerously-skip-permissions --model ${model} '${escaped}' 2>&1 | tee /tmp/claude-output.log`;
            },
            buildEnvVars() {
                return [
                    `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
                ];
            },
            filterOutput: filterClaudeOutput,
        };
    }
}
//# sourceMappingURL=provider.js.map