// ---------------------------------------------------------------------------
// Aider AI Provider
// ---------------------------------------------------------------------------
import { BaseAIProvider, } from "@orchestrator/contracts";
export const aiderSchema = {
    type: "aider",
    category: "ai",
    displayName: "Aider",
    fields: [
        { key: "aiderBackend", label: "Backend", type: "select", required: true, default: "anthropic", options: [
                { label: "Anthropic", value: "anthropic" },
                { label: "OpenAI", value: "openai" },
                { label: "Ollama", value: "ollama" },
            ] },
        { key: "model", label: "Model", type: "string", description: "Model name (e.g. sonnet, opus, gpt-4o, llama3)" },
    ],
};
function filterAiderOutput(raw) {
    if (!raw)
        return "";
    const lines = raw.split("\n").filter((line) => {
        if (/^Aider v\d/.test(line))
            return false;
        if (line.startsWith("Repo-map:"))
            return false;
        if (line.startsWith("Use /help"))
            return false;
        if (line.startsWith("Model:"))
            return false;
        if (line.startsWith("Git repo:"))
            return false;
        if (line.startsWith("Weak model:"))
            return false;
        if (/^[\s│┌┐└┘─╭╮╰╯┤├]+$/.test(line))
            return false;
        return true;
    });
    return lines.join("\n").trim();
}
function resolveAiderModelFlag(backend, model) {
    switch (backend) {
        case "anthropic": {
            const m = model || "claude-sonnet-4-20250514";
            const shortMap = {
                sonnet: "claude-sonnet-4-20250514",
                opus: "claude-opus-4-20250514",
                haiku: "claude-haiku-4-5-20251001",
            };
            const resolved = shortMap[m] || m;
            return `--model anthropic/${resolved}`;
        }
        case "openai": {
            const m = model || "gpt-4o";
            return `--model openai/${m}`;
        }
        case "ollama": {
            const m = model || "llama3";
            return `--model ollama/${m}`;
        }
        default:
            return `--model anthropic/claude-sonnet-4-20250514`;
    }
}
export class AiderProvider extends BaseAIProvider {
    constructor() {
        super(...arguments);
        this.name = "aider";
        this.schema = aiderSchema;
    }
    createDriver(config) {
        const backend = (config.aiderBackend || "anthropic");
        const model = config.model;
        const modelFlag = resolveAiderModelFlag(backend, model);
        return {
            processPattern: "aider.*--yes-always",
            outputLogPath: "/tmp/aider-output.log",
            buildLaunchCommand(prompt) {
                const escaped = prompt.replace(/'/g, "'\\''");
                return `gosu agent aider ${modelFlag} --yes-always --no-pretty --no-auto-commits --message '${escaped}' 2>&1 | tee /tmp/aider-output.log`;
            },
            buildEnvVars(_projectConfig, instanceConfig) {
                const vars = [];
                switch (backend) {
                    case "anthropic":
                        vars.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`);
                        break;
                    case "openai":
                        vars.push(`OPENAI_API_KEY=${(instanceConfig === null || instanceConfig === void 0 ? void 0 : instanceConfig.OPENAI_API_KEY) || process.env.OPENAI_API_KEY || ""}`);
                        break;
                    case "ollama":
                        vars.push("OLLAMA_API_BASE=http://host.docker.internal:11434");
                        break;
                }
                return vars;
            },
            filterOutput: filterAiderOutput,
        };
    }
}
//# sourceMappingURL=provider.js.map