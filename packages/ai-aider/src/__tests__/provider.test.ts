import { describe, it, expect } from "vitest";
import { AiderProvider, aiderSchema } from "../provider.js";

describe("AiderProvider", () => {
  it("has correct metadata", () => {
    const provider = new AiderProvider();
    expect(provider.name).toBe("aider");
    expect(provider.schema.category).toBe("ai");
    expect(provider.schema.displayName).toBe("Aider");
  });

  it("schema has backend and model fields", () => {
    const backendField = aiderSchema.fields.find((f) => f.key === "aiderBackend");
    expect(backendField).toBeDefined();
    expect(backendField!.options!.map((o) => o.value)).toEqual(["anthropic", "openai", "ollama"]);
    expect(backendField!.default).toBe("anthropic");

    const modelField = aiderSchema.fields.find((f) => f.key === "model");
    expect(modelField).toBeDefined();
  });

  describe("createDriver — anthropic backend", () => {
    it("defaults to claude-sonnet model", () => {
      const driver = new AiderProvider().createDriver({ aiderBackend: "anthropic" });
      const cmd = driver.buildLaunchCommand("task");
      expect(cmd).toContain("--model anthropic/claude-sonnet-4-20250514");
    });

    it("expands short model names", () => {
      const cases = [
        { model: "sonnet", expected: "anthropic/claude-sonnet-4-20250514" },
        { model: "opus", expected: "anthropic/claude-opus-4-20250514" },
        { model: "haiku", expected: "anthropic/claude-haiku-4-5-20251001" },
      ];
      for (const { model, expected } of cases) {
        const driver = new AiderProvider().createDriver({ aiderBackend: "anthropic", model });
        const cmd = driver.buildLaunchCommand("x");
        expect(cmd).toContain(`--model ${expected}`);
      }
    });

    it("passes through full model names", () => {
      const driver = new AiderProvider().createDriver({ aiderBackend: "anthropic", model: "claude-3-haiku-20240307" });
      const cmd = driver.buildLaunchCommand("x");
      expect(cmd).toContain("--model anthropic/claude-3-haiku-20240307");
    });

    it("sets ANTHROPIC_API_KEY env var", () => {
      const driver = new AiderProvider().createDriver({ aiderBackend: "anthropic" });
      const vars = driver.buildEnvVars({});
      expect(vars.some((v) => v.startsWith("ANTHROPIC_API_KEY="))).toBe(true);
    });
  });

  describe("createDriver — openai backend", () => {
    it("defaults to gpt-4o", () => {
      const driver = new AiderProvider().createDriver({ aiderBackend: "openai" });
      const cmd = driver.buildLaunchCommand("x");
      expect(cmd).toContain("--model openai/gpt-4o");
    });

    it("uses custom model", () => {
      const driver = new AiderProvider().createDriver({ aiderBackend: "openai", model: "gpt-4-turbo" });
      const cmd = driver.buildLaunchCommand("x");
      expect(cmd).toContain("--model openai/gpt-4-turbo");
    });

    it("sets OPENAI_API_KEY from instanceConfig", () => {
      const driver = new AiderProvider().createDriver({ aiderBackend: "openai" });
      const vars = driver.buildEnvVars({}, { OPENAI_API_KEY: "sk-test" });
      expect(vars).toContain("OPENAI_API_KEY=sk-test");
    });
  });

  describe("createDriver — ollama backend", () => {
    it("defaults to llama3", () => {
      const driver = new AiderProvider().createDriver({ aiderBackend: "ollama" });
      const cmd = driver.buildLaunchCommand("x");
      expect(cmd).toContain("--model ollama/llama3");
    });

    it("sets OLLAMA_API_BASE env var", () => {
      const driver = new AiderProvider().createDriver({ aiderBackend: "ollama" });
      const vars = driver.buildEnvVars({});
      expect(vars).toContain("OLLAMA_API_BASE=http://host.docker.internal:11434");
    });
  });

  describe("driver general properties", () => {
    it("has correct process pattern", () => {
      const driver = new AiderProvider().createDriver({});
      expect(driver.processPattern).toBe("aider.*--yes-always");
    });

    it("has correct output log path", () => {
      const driver = new AiderProvider().createDriver({});
      expect(driver.outputLogPath).toBe("/tmp/aider-output.log");
    });

    it("command includes --yes-always and --no-auto-commits", () => {
      const driver = new AiderProvider().createDriver({});
      const cmd = driver.buildLaunchCommand("fix it");
      expect(cmd).toContain("--yes-always");
      expect(cmd).toContain("--no-pretty");
      expect(cmd).toContain("--no-auto-commits");
      expect(cmd).toContain("tee /tmp/aider-output.log");
    });

    it("escapes single quotes in prompt", () => {
      const driver = new AiderProvider().createDriver({});
      const cmd = driver.buildLaunchCommand("it's broken");
      expect(cmd).toContain("it'\\''s broken");
    });

    it("filterOutput strips aider-specific noise", () => {
      const driver = new AiderProvider().createDriver({});
      const raw = [
        "Aider v0.50.0",
        "Model: gpt-4o",
        "Git repo: /app",
        "Repo-map: using ...",
        "Use /help for commands",
        "Weak model: gpt-3.5",
        "Actual output here",
        "│  ┌──────────┐  │",
        "More output",
      ].join("\n");

      const filtered = driver.filterOutput(raw);
      expect(filtered).toBe("Actual output here\nMore output");
    });
  });

  describe("createDriver — default backend", () => {
    it("defaults to anthropic when no backend specified", () => {
      const driver = new AiderProvider().createDriver({});
      const cmd = driver.buildLaunchCommand("x");
      expect(cmd).toContain("--model anthropic/");
    });
  });
});
