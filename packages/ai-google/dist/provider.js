// ---------------------------------------------------------------------------
// Google Gemini AI Provider (Gemini CLI)
// ---------------------------------------------------------------------------
import { BaseAIProvider, } from "@orchestrator/contracts";
export const geminiSchema = {
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
function filterGeminiOutput(raw) {
    if (!raw)
        return "";
    const lines = raw.split("\n").filter((line) => {
        // Strip timestamp-prefixed lines
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/.test(line))
            return false;
        // Strip entrypoint/runtime logs
        if (line.includes("[entrypoint]"))
            return false;
        if (line.includes("[runtime]"))
            return false;
        // Strip empty box-drawing lines
        if (/^[\s│┌┐└┘─╭╮╰╯┤├]+$/.test(line))
            return false;
        return true;
    });
    return lines.join("\n").trim();
}
export class GeminiProvider extends BaseAIProvider {
    constructor() {
        super(...arguments);
        this.name = "gemini";
        this.schema = geminiSchema;
    }
    createDriver(config) {
        const model = config.model || "gemini-2.5-pro";
        return {
            processPattern: "gemini.*-p",
            outputLogPath: "/tmp/gemini-output.log",
            buildLaunchCommand(prompt) {
                const escaped = prompt.replace(/'/g, "'\\''");
                return `gosu agent gemini -p --yes --model ${model} '${escaped}' 2>&1 | tee /tmp/gemini-output.log`;
            },
            buildEnvVars(_projectConfig, instanceConfig) {
                return [
                    `GEMINI_API_KEY=${(instanceConfig === null || instanceConfig === void 0 ? void 0 : instanceConfig.apiKey) || process.env.GEMINI_API_KEY || ""}`,
                ];
            },
            filterOutput: filterGeminiOutput,
        };
    }
}
//# sourceMappingURL=provider.js.map