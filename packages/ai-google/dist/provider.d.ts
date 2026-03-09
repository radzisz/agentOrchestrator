import { BaseAIProvider, type AIProviderDriver, type ProviderTypeSchema } from "@orchestrator/contracts";
export declare const geminiSchema: ProviderTypeSchema;
export declare class GeminiProvider extends BaseAIProvider {
    readonly name = "gemini";
    readonly schema: ProviderTypeSchema;
    createDriver(config: Record<string, string>): AIProviderDriver;
}
//# sourceMappingURL=provider.d.ts.map