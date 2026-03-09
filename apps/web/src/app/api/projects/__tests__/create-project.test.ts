import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { ensureGitRepo, discoverGitRemoteUrl } from "../route";

// ---------------------------------------------------------------------------
// ensureGitRepo
// ---------------------------------------------------------------------------

describe("ensureGitRepo", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "test-project-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes git in a directory without .git", () => {
    // Directory exists, no .git
    const result = ensureGitRepo(tempDir);

    expect(result).toBe(true);
    expect(existsSync(join(tempDir, ".git"))).toBe(true);
  });

  it("creates .gitignore with orchestrator entries", () => {
    ensureGitRepo(tempDir);

    const gitignore = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".10timesdev/");
    expect(gitignore).toContain(".env.10timesdev");
  });

  it("creates an initial commit", () => {
    ensureGitRepo(tempDir);

    const log = execSync("git log --oneline", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(log).toContain("Initial commit");
  });

  it("returns false if directory already has .git", () => {
    execSync("git init", { cwd: tempDir, stdio: "pipe" });
    execSync("git commit --allow-empty -m init", { cwd: tempDir, stdio: "pipe" });

    const result = ensureGitRepo(tempDir);

    expect(result).toBe(false);
  });

  it("returns false if directory does not exist", () => {
    const result = ensureGitRepo(join(tempDir, "nonexistent"));

    expect(result).toBe(false);
  });

  it("appends to existing .gitignore without duplicating", () => {
    writeFileSync(join(tempDir, ".gitignore"), "node_modules/\n.env.10timesdev\n");

    ensureGitRepo(tempDir);

    const gitignore = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    // .10timesdev/ should be added, .env.10timesdev should NOT be duplicated
    expect(gitignore).toContain(".10timesdev/");
    const envCount = gitignore.split(".env.10timesdev").length - 1;
    expect(envCount).toBe(1);
  });

  it("orchestrator files are not tracked by git", () => {
    // Create some orchestrator files before git init
    mkdirSync(join(tempDir, ".10timesdev"), { recursive: true });
    writeFileSync(join(tempDir, ".10timesdev", "config.json"), "{}");
    writeFileSync(join(tempDir, ".env.10timesdev"), "SECRET=123");

    ensureGitRepo(tempDir);

    // Check that orchestrator files are ignored
    const tracked = execSync("git ls-files", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(tracked).not.toContain(".10timesdev/");
    expect(tracked).not.toContain(".env.10timesdev");
    expect(tracked).toContain(".gitignore");
  });
});

// ---------------------------------------------------------------------------
// discoverGitRemoteUrl
// ---------------------------------------------------------------------------

describe("discoverGitRemoteUrl", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "test-git-remote-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null if no .git directory", () => {
    expect(discoverGitRemoteUrl(tempDir)).toBeNull();
  });

  it("returns null if no remote configured", () => {
    execSync("git init", { cwd: tempDir, stdio: "pipe" });
    expect(discoverGitRemoteUrl(tempDir)).toBeNull();
  });

  it("returns HTTPS URL for HTTPS remote", () => {
    execSync("git init", { cwd: tempDir, stdio: "pipe" });
    execSync("git remote add origin https://github.com/org/repo.git", { cwd: tempDir, stdio: "pipe" });

    expect(discoverGitRemoteUrl(tempDir)).toBe("https://github.com/org/repo");
  });

  it("converts SSH remote to HTTPS", () => {
    execSync("git init", { cwd: tempDir, stdio: "pipe" });
    execSync("git remote add origin git@github.com:org/repo.git", { cwd: tempDir, stdio: "pipe" });

    expect(discoverGitRemoteUrl(tempDir)).toBe("https://github.com/org/repo");
  });
});
