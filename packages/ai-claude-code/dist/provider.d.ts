import { BaseAIProvider, type AIProviderDriver, type ProviderTypeSchema } from "@orchestrator/contracts";
export declare const claudeCodeSchema: ProviderTypeSchema;
export declare class ClaudeCodeProvider extends BaseAIProvider {
    readonly name = "claude-code";
    readonly schema: ProviderTypeSchema;
    createDriver(config: Record<string, string>): AIProviderDriver;
}
//# sourceMappingURL=provider.d.ts.map