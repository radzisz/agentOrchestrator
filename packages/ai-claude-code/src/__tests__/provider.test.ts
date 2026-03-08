import { describe, it, expect } from "vitest";
import { ClaudeCodeProvider, claudeCodeSchema } from "../provider.js";

describe("ClaudeCodeProvider", () => {
  it("has correct metadata", () => {
    const provider = new ClaudeCodeProvider();
    expect(provider.name).toBe("claude-code");
    expect(provider.schema.category).toBe("ai");
    expect(provider.schema.displayName).toBe("Claude Code");
  });

  it("schema exposes model options", () => {
    const modelField = claudeCodeSchema.fields.find((f) => f.key === "model");
    expect(modelField).toBeDefined();
    expect(modelField!.type).toBe("select");
    expect(modelField!.options!.map((o) => o.value)).toEqual(["sonnet", "opus", "haiku"]);
    expect(modelField!.default).toBe("sonnet");
  });

  describe("createDriver", () => {
    it("defaults to sonnet model", () => {
      const driver = new ClaudeCodeProvider().createDriver({});
      expect(driver.processPattern).toBe("claude.*--dangerously-skip-permissions");
      expect(driver.outputLogPath).toBe("/tmp/claude-output.log");
      const cmd = driver.buildLaunchCommand("hello");
      expect(cmd).toContain("--model sonnet");
    });

    it("uses configured model", () => {
      const driver = new ClaudeCodeProvider().createDriver({ model: "opus" });
      const cmd = driver.buildLaunchCommand("task");
      expect(cmd).toContain("--model opus");
    });

    it("escapes single quotes in prompt", () => {
      const driver = new ClaudeCodeProvider().createDriver({});
      const cmd = driver.buildLaunchCommand("it's a test");
      expect(cmd).toContain("it'\\''s a test");
      expect(cmd).not.toContain("it's");
    });

    it("builds launch command with tee", () => {
      const driver = new ClaudeCodeProvider().createDriver({});
      const cmd = driver.buildLaunchCommand("do stuff");
      expect(cmd).toContain("gosu agent claude");
      expect(cmd).toContain("--dangerously-skip-permissions");
      expect(cmd).toContain("tee /tmp/claude-output.log");
    });

    it("includes ANTHROPIC_API_KEY in env vars", () => {
      const driver = new ClaudeCodeProvider().createDriver({});
      const vars = driver.buildEnvVars({});
      expect(vars.some((v) => v.startsWith("ANTHROPIC_API_KEY="))).toBe(true);
    });

    it("filterOutput strips noise lines", () => {
      const driver = new ClaudeCodeProvider().createDriver({});
      const raw = [
        "2026-01-01T00:00:00.000Z some log",
        "[entrypoint] starting",
        "[runtime] init",
        "node --trace-warnings",
        "Unable to open browser automatically",
        "Starting framework dev server",
        "Actual useful output",
        "│  ┌──────────┐  │",
        "More useful output",
      ].join("\n");

      const filtered = driver.filterOutput(raw);
      expect(filtered).toBe("Actual useful output\nMore useful output");
    });

    it("filterOutput handles empty input", () => {
      const driver = new ClaudeCodeProvider().createDriver({});
      expect(driver.filterOutput("")).toBe("");
    });
  });
});
