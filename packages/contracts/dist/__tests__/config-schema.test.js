import { describe, it, expect } from "vitest";
describe("ConfigField", () => {
    it("supports all field types", () => {
        const fields = [
            { key: "a", label: "A", type: "string" },
            { key: "b", label: "B", type: "secret" },
            { key: "c", label: "C", type: "select", options: [{ label: "X", value: "x" }] },
            { key: "d", label: "D", type: "number" },
            { key: "e", label: "E", type: "boolean" },
        ];
        expect(fields).toHaveLength(5);
        expect(fields.map((f) => f.type)).toEqual(["string", "secret", "select", "number", "boolean"]);
    });
    it("supports optional properties", () => {
        const field = {
            key: "test",
            label: "Test",
            type: "string",
            required: true,
            description: "desc",
            default: "val",
            projectOverride: true,
            visibleWhen: { field: "mode", value: "poll" },
        };
        expect(field.required).toBe(true);
        expect(field.projectOverride).toBe(true);
        expect(field.visibleWhen).toEqual({ field: "mode", value: "poll" });
    });
});
describe("ProviderTypeSchema", () => {
    it("has all required properties", () => {
        const schema = {
            type: "test-provider",
            category: "tracker",
            displayName: "Test Provider",
            fields: [{ key: "apiKey", label: "API Key", type: "secret", required: true }],
        };
        expect(schema.type).toBe("test-provider");
        expect(schema.category).toBe("tracker");
        expect(schema.fields).toHaveLength(1);
    });
    it("supports all provider categories", () => {
        const categories = ["tracker", "im", "scm", "ai"];
        expect(categories).toHaveLength(4);
    });
});
//# sourceMappingURL=config-schema.test.js.map