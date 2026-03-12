import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { ensureGitRepo, discoverGitRemoteUrl, createProject } from "../route";
import * as store from "@/lib/store";

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

// ---------------------------------------------------------------------------
// createProject → listProjects (project visible without restart)
// ---------------------------------------------------------------------------

// Mock simpleGit so we don't do real network clone
vi.mock("@/lib/cmd", () => ({
  simpleGit: vi.fn(() => ({
    clone: vi.fn(async () => {}),
    addConfig: vi.fn(async () => {}),
  })),
}));

// Mock getBasePath to return our temp dir
vi.mock("@/integrations/local-drive", () => ({
  getBasePath: vi.fn(async () => tmpdir()),
}));

describe("createProject → listProjects (no restart)", () => {
  const projectName = `__test_project_${Date.now()}`;
  let tempProjectPath: string;

  afterEach(() => {
    // Clean up: remove from store and disk
    store.removeProject(projectName);
    if (tempProjectPath && existsSync(tempProjectPath)) {
      rmSync(tempProjectPath, { recursive: true, force: true });
    }
  });

  it("newly created project appears in listProjects immediately", async () => {
    // Set up a temp directory that looks like a git repo
    tempProjectPath = join(tmpdir(), projectName);
    mkdirSync(tempProjectPath, { recursive: true });
    mkdirSync(join(tempProjectPath, ".git"), { recursive: true });

    // Verify project doesn't exist yet
    const before = store.listProjects();
    expect(before.find((p) => p.name === projectName)).toBeUndefined();

    // Create via the same function the POST handler calls
    const result = await createProject({
      name: projectName,
      repoPath: tempProjectPath,
    });

    expect(result.name).toBe(projectName);
    expect(result.path).toBe(tempProjectPath);

    // Immediately list — must include the new project
    const after = store.listProjects();
    const found = after.find((p) => p.name === projectName);
    expect(found).toBeDefined();
    expect(found!.path).toBe(tempProjectPath);
  });

  it("project created via URL (clone) is listed immediately", async () => {
    tempProjectPath = join(tmpdir(), projectName);
    // simpleGit.clone is mocked — simulate that it creates the dir with .git
    mkdirSync(tempProjectPath, { recursive: true });
    mkdirSync(join(tempProjectPath, ".git"), { recursive: true });

    const result = await createProject({
      name: projectName,
      repoUrl: "https://github.com/test/repo",
      repoPath: tempProjectPath,
    });

    expect(result.name).toBe(projectName);

    // List must include it without any restart
    const projects = store.listProjects();
    const found = projects.find((p) => p.name === projectName);
    expect(found).toBeDefined();
    expect(found!.path).toBe(tempProjectPath);
  });

  it("project config (REPO_URL) is readable after create", async () => {
    tempProjectPath = join(tmpdir(), projectName);
    mkdirSync(tempProjectPath, { recursive: true });
    mkdirSync(join(tempProjectPath, ".git"), { recursive: true });

    await createProject({
      name: projectName,
      repoPath: tempProjectPath,
      repoUrl: "https://github.com/org/myrepo",
    });

    const cfg = store.getProjectConfig(tempProjectPath);
    expect(cfg.REPO_URL).toBe("https://github.com/org/myrepo");
  });

  it("removed project disappears from listProjects immediately", async () => {
    tempProjectPath = join(tmpdir(), projectName);
    mkdirSync(tempProjectPath, { recursive: true });
    mkdirSync(join(tempProjectPath, ".git"), { recursive: true });

    await createProject({ name: projectName, repoPath: tempProjectPath });

    // Verify it's there
    expect(store.listProjects().find((p) => p.name === projectName)).toBeDefined();

    // Remove
    store.removeProject(projectName);

    // Must be gone immediately
    expect(store.listProjects().find((p) => p.name === projectName)).toBeUndefined();
  });

  it("removing a project does not affect other projects", async () => {
    const otherName = `__test_other_${Date.now()}`;
    const otherPath = join(tmpdir(), otherName);
    tempProjectPath = join(tmpdir(), projectName);

    mkdirSync(tempProjectPath, { recursive: true });
    mkdirSync(join(tempProjectPath, ".git"), { recursive: true });
    mkdirSync(otherPath, { recursive: true });
    mkdirSync(join(otherPath, ".git"), { recursive: true });

    await createProject({ name: projectName, repoPath: tempProjectPath });
    await createProject({ name: otherName, repoPath: otherPath });

    // Both exist
    expect(store.listProjects().find((p) => p.name === projectName)).toBeDefined();
    expect(store.listProjects().find((p) => p.name === otherName)).toBeDefined();

    // Remove one
    store.removeProject(projectName);

    // Only the removed one is gone
    expect(store.listProjects().find((p) => p.name === projectName)).toBeUndefined();
    expect(store.listProjects().find((p) => p.name === otherName)).toBeDefined();

    // Clean up other
    store.removeProject(otherName);
    rmSync(otherPath, { recursive: true, force: true });
  });
});
