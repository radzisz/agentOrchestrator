import { BaseIMProvider, type ProviderTypeSchema } from "@orchestrator/contracts";
export declare const telegramSchema: ProviderTypeSchema;
export declare class TelegramIMProvider extends BaseIMProvider {
    readonly name = "telegram";
    readonly schema: ProviderTypeSchema;
    /**
     * Optional callback to persist topic IDs.
     * The host provides this so the provider doesn't need to access storage.
     */
    onTopicCreated?: (issueId: string, topicId: string) => void;
    /**
     * Optional callback to resolve topic IDs.
     * The host provides this so the provider doesn't need to access storage.
     */
    getTopicId?: (issueId: string) => string | null;
    send(config: Record<string, string>, issueId: string, message: string): Promise<void>;
    ensureTopic(config: Record<string, string>, issueId: string, title: string): Promise<string | null>;
    closeTopic(config: Record<string, string>, issueId: string): Promise<void>;
    private _ensureTopic;
}
//# sourceMappingURL=provider.d.ts.map