import { BaseAIProvider, type AIProviderDriver, type ProviderTypeSchema } from "@orchestrator/contracts";
export type AiderBackend = "anthropic" | "openai" | "ollama";
export declare const aiderSchema: ProviderTypeSchema;
export declare class AiderProvider extends BaseAIProvider {
    readonly name = "aider";
    readonly schema: ProviderTypeSchema;
    createDriver(config: Record<string, string>): AIProviderDriver;
}
//# sourceMappingURL=provider.d.ts.map