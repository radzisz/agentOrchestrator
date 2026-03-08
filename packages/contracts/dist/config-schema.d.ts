export interface ConfigField {
    key: string;
    label: string;
    type: "string" | "secret" | "select" | "number" | "boolean";
    required?: boolean;
    description?: string;
    default?: string;
    options?: Array<{
        label: string;
        value: string;
    }>;
    projectOverride?: boolean;
    visibleWhen?: {
        field: string;
        value: string;
    };
}
export type ProviderCategory = "tracker" | "im" | "scm" | "ai";
export interface ProviderTypeSchema {
    type: string;
    category: ProviderCategory;
    displayName: string;
    fields: ConfigField[];
}
//# sourceMappingURL=config-schema.d.ts.map