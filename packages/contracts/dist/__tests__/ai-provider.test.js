import { describe, it, expect } from "vitest";
import { BaseAIProvider } from "../ai-provider.js";
class MockAIProvider extends BaseAIProvider {
    constructor() {
        super(...arguments);
        this.name = "mock";
        this.schema = {
            type: "mock",
            category: "ai",
            displayName: "Mock AI",
            fields: [{ key: "model", label: "Model", type: "string" }],
        };
    }
    createDriver(config) {
        const model = config.model || "default";
        return {
            processPattern: `mock-${model}`,
            outputLogPath: "/tmp/mock.log",
            buildLaunchCommand(prompt) { return `mock-run --model ${model} "${prompt}"`; },
            buildEnvVars() { return [`MODEL=${model}`]; },
            filterOutput(raw) { return raw.trim(); },
        };
    }
}
describe("BaseAIProvider", () => {
    it("creates a driver with correct config", () => {
        const provider = new MockAIProvider();
        const driver = provider.createDriver({ model: "gpt-4o" });
        expect(driver.processPattern).toBe("mock-gpt-4o");
        expect(driver.outputLogPath).toBe("/tmp/mock.log");
    });
    it("driver builds launch command with prompt", () => {
        const provider = new MockAIProvider();
        const driver = provider.createDriver({ model: "test" });
        const cmd = driver.buildLaunchCommand("fix the bug");
        expect(cmd).toContain("fix the bug");
        expect(cmd).toContain("test");
    });
    it("driver builds env vars", () => {
        const provider = new MockAIProvider();
        const driver = provider.createDriver({ model: "mymodel" });
        expect(driver.buildEnvVars({})).toEqual(["MODEL=mymodel"]);
    });
    it("driver filters output", () => {
        const provider = new MockAIProvider();
        const driver = provider.createDriver({});
        expect(driver.filterOutput("  hello  ")).toBe("hello");
    });
    it("uses defaults when config is empty", () => {
        const provider = new MockAIProvider();
        const driver = provider.createDriver({});
        expect(driver.processPattern).toBe("mock-default");
    });
});
//# sourceMappingURL=ai-provider.test.js.map