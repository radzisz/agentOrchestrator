import type { ProviderTypeSchema } from "./config-schema";
export declare abstract class BaseIMProvider {
    abstract readonly name: string;
    abstract readonly schema: ProviderTypeSchema;
    abstract send(config: Record<string, string>, issueId: string, message: string): Promise<void>;
    ensureTopic?(config: Record<string, string>, issueId: string, title: string): Promise<string | null>;
    closeTopic?(config: Record<string, string>, issueId: string): Promise<void>;
}
//# sourceMappingURL=im-provider.d.ts.map