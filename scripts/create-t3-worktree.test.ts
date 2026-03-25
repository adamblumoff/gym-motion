import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorktree,
  getSourceEnvPath,
  getWorktreePath,
  parseCliArgs,
  provisionEnvFile,
  runCli,
  type RuntimeDependencies,
} from "./create-t3-worktree";

const execFile = promisify(execFileCallback);

async function initGitRepo(repoRoot: string) {
  await execFile("git", ["init", "-b", "main"], { cwd: repoRoot });
  await execFile("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot });
  await execFile("git", ["config", "user.name", "Codex"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "# temp repo\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repoRoot });
  await execFile("git", ["commit", "-m", "init"], { cwd: repoRoot });
}

async function createTempRepo() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gym-motion-worktree-test-"));
  const repoRoot = path.join(tempRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
  await initGitRepo(repoRoot);
  return { repoRoot, tempRoot };
}

function createDeps(overrides: Partial<RuntimeDependencies> = {}): RuntimeDependencies {
  return {
    copyFile: overrides.copyFile ?? vi.fn(async () => undefined),
    existsSync: overrides.existsSync ?? existsSync,
    hardLink: overrides.hardLink ?? vi.fn(async () => undefined),
    lstat:
      overrides.lstat ??
      (async (targetPath) => {
        const { lstat } = await import("node:fs/promises");
        return lstat(targetPath);
      }),
    mkdir:
      overrides.mkdir ??
      (async (targetPath, options) => {
        const { mkdir } = await import("node:fs/promises");
        return mkdir(targetPath, options);
      }),
    osHomedir: overrides.osHomedir ?? (() => "C:\\Users\\tester"),
    removeFile:
      overrides.removeFile ??
      (async (targetPath) => {
        const { unlink } = await import("node:fs/promises");
        return unlink(targetPath);
      }),
    removePath:
      overrides.removePath ??
      (async (targetPath, options) => {
        const { rm } = await import("node:fs/promises");
        return rm(targetPath, options);
      }),
    repoRoot: overrides.repoRoot ?? "C:\\repo\\gym-motion",
    runGit:
      overrides.runGit ??
      (async () => {
        throw new Error("runGit stub not provided");
      }),
    symlink:
      overrides.symlink ??
      (async () => {
        throw new Error("symlink stub not provided");
      }),
  };
}

describe("create-t3-worktree cli parsing", () => {
  it("parses positional args and defaults", () => {
    expect(parseCliArgs(["feature-123", "feature/my-branch"])).toEqual({
      baseRef: "main",
      branchName: "feature/my-branch",
      copyEnv: false,
      forceEnv: false,
      pathOnly: false,
      worktreeName: "feature-123",
    });
  });

  it("parses optional flags", () => {
    expect(
      parseCliArgs([
        "feature-123",
        "feature/my-branch",
        "--base",
        "release",
        "--copy-env",
        "--force-env",
        "--path-only",
      ]),
    ).toEqual({
      baseRef: "release",
      branchName: "feature/my-branch",
      copyEnv: true,
      forceEnv: true,
      pathOnly: true,
      worktreeName: "feature-123",
    });
  });
});

describe("create-t3-worktree path helpers", () => {
  it("derives the expected source env path", () => {
    expect(getSourceEnvPath({ repoRoot: "C:\\repo\\gym-motion" })).toBe("C:\\repo\\gym-motion\\.env.local");
  });

  it("derives the expected t3 worktree path", () => {
    expect(getWorktreePath("feature-123", { osHomedir: () => "C:\\Users\\tester" })).toBe(
      "C:\\Users\\tester\\.t3\\worktrees\\gym-motion\\feature-123",
    );
  });
});

describe("create-t3-worktree env provisioning", () => {
  it("uses symlink mode when available", async () => {
    const symlink = vi.fn(async () => undefined);
    const deps = createDeps({ symlink });

    const result = await provisionEnvFile("source", "target", { copyEnv: false, forceEnv: false }, deps);

    expect(result).toEqual({ mode: "symlink" });
    expect(symlink).toHaveBeenCalledWith("source", "target", "file");
  });

  it("falls back to hardlink when symlink creation fails", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlink denied");
    });
    const hardLink = vi.fn(async () => undefined);
    const copyFile = vi.fn(async () => undefined);
    const deps = createDeps({ copyFile, hardLink, symlink });

    const result = await provisionEnvFile("source", "target", { copyEnv: false, forceEnv: false }, deps);

    expect(result.mode).toBe("hardlink");
    expect(result.warning).toContain("symlink fallback");
    expect(hardLink).toHaveBeenCalledWith("source", "target");
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("falls back to copy when both link modes fail", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlink denied");
    });
    const copyFile = vi.fn(async () => undefined);
    const hardLink = vi.fn(async () => {
      throw new Error("hardlink denied");
    });
    const deps = createDeps({
      copyFile,
      hardLink,
      symlink,
    });

    const result = await provisionEnvFile("source", "target", { copyEnv: false, forceEnv: false }, deps);

    expect(result.mode).toBe("copy");
    expect(result.warning).toContain("not live-synced");
    expect(copyFile).toHaveBeenCalled();
  });

  it("refuses to overwrite an existing env target without force", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "gym-motion-existing-env-"));
    const targetEnvPath = path.join(tempDir, ".env.local");
    await writeFile(targetEnvPath, "API_URL=http://example.test\n", "utf8");

    await expect(
      provisionEnvFile("source", targetEnvPath, { copyEnv: false, forceEnv: false }, createDeps()),
    ).rejects.toThrow("Refusing to overwrite existing .env.local");
  });
});

describe("create-t3-worktree git integration", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.map(async (tempRoot) => {
        const { rm } = await import("node:fs/promises");
        await rm(tempRoot, { force: true, recursive: true });
      }),
    );
    tempRoots.length = 0;
  });

  it("creates a new branch from main when it does not exist", async () => {
    const { repoRoot, tempRoot } = await createTempRepo();
    tempRoots.push(tempRoot);
    const worktreePath = path.join(tempRoot, "worktrees", "feature-a");
    const deps = createDeps({
      repoRoot,
      runGit: async (args, cwd) => {
        const { stdout } = await execFile("git", args, { cwd });
        return stdout.trim();
      },
    });

    const result = await createGitWorktree(worktreePath, { baseRef: "main", branchName: "feature/a" }, deps);

    expect(result.branchExists).toBe(false);
    expect(existsSync(path.join(worktreePath, ".git"))).toBe(true);
  });

  it("attaches to an existing branch when it already exists", async () => {
    const { repoRoot, tempRoot } = await createTempRepo();
    tempRoots.push(tempRoot);
    await execFile("git", ["branch", "feature/existing"], { cwd: repoRoot });

    const worktreePath = path.join(tempRoot, "worktrees", "feature-existing");
    const deps = createDeps({
      repoRoot,
      runGit: async (args, cwd) => {
        const { stdout } = await execFile("git", args, { cwd });
        return stdout.trim();
      },
    });

    const result = await createGitWorktree(worktreePath, { baseRef: "main", branchName: "feature/existing" }, deps);

    expect(result.branchExists).toBe(true);
    expect(existsSync(path.join(worktreePath, ".git"))).toBe(true);
  });

  it("cleans up the worktree if env provisioning fails after creation", async () => {
    const { repoRoot, tempRoot } = await createTempRepo();
    tempRoots.push(tempRoot);
    await writeFile(path.join(repoRoot, ".env.local"), "API_URL=http://example.test\n", "utf8");

    const t3Home = path.join(tempRoot, "home");
    const deps = createDeps({
      existsSync,
      osHomedir: () => t3Home,
      repoRoot,
      runGit: async (args, cwd) => {
        const { stdout } = await execFile("git", args, { cwd });
        return stdout.trim();
      },
      hardLink: async () => {
        throw new Error("hardlink denied");
      },
      symlink: async () => {
        throw new Error("symlink denied");
      },
    });
    const copyFile = vi.fn(async () => {
      throw new Error("copy failed");
    });

    await expect(runCli(["feature-cleanup", "feature/cleanup"], { ...deps, copyFile })).rejects.toThrow("copy failed");

    expect(existsSync(getWorktreePath("feature-cleanup", deps))).toBe(false);
  });

  it("creates a worktree with a copied env file when requested", async () => {
    const { repoRoot, tempRoot } = await createTempRepo();
    tempRoots.push(tempRoot);
    await writeFile(path.join(repoRoot, ".env.local"), "API_URL=http://example.test\n", "utf8");

    const t3Home = path.join(tempRoot, "home");
    const actualCopyFile = (await import("node:fs/promises")).copyFile;
    const actualLink = (await import("node:fs/promises")).link;
    const actualLstat = (await import("node:fs/promises")).lstat;
    const actualMkdir = (await import("node:fs/promises")).mkdir;
    const actualRm = (await import("node:fs/promises")).rm;
    const actualSymlink = (await import("node:fs/promises")).symlink;
    const actualUnlink = (await import("node:fs/promises")).unlink;

    const deps = createDeps({
      copyFile: actualCopyFile,
      existsSync,
      hardLink: actualLink,
      lstat: actualLstat,
      mkdir: actualMkdir,
      osHomedir: () => t3Home,
      removeFile: actualUnlink,
      removePath: actualRm,
      repoRoot,
      runGit: async (args, cwd) => {
        const { stdout } = await execFile("git", args, { cwd });
        return stdout.trim();
      },
      symlink: actualSymlink,
    });

    await runCli(["feature-copy", "feature/copy", "--copy-env"], deps);

    const targetEnvPath = path.join(getWorktreePath("feature-copy", deps), ".env.local");
    expect(await readFile(targetEnvPath, "utf8")).toContain("API_URL=http://example.test");
  });

  it("reuses an existing matching worktree on rerun", async () => {
    const { repoRoot, tempRoot } = await createTempRepo();
    tempRoots.push(tempRoot);
    await writeFile(path.join(repoRoot, ".env.local"), "API_URL=http://example.test\n", "utf8");

    const t3Home = path.join(tempRoot, "home");
    const actualCopyFile = (await import("node:fs/promises")).copyFile;
    const actualLink = (await import("node:fs/promises")).link;
    const actualLstat = (await import("node:fs/promises")).lstat;
    const actualMkdir = (await import("node:fs/promises")).mkdir;
    const actualRm = (await import("node:fs/promises")).rm;
    const actualSymlink = (await import("node:fs/promises")).symlink;
    const actualUnlink = (await import("node:fs/promises")).unlink;

    const deps = createDeps({
      copyFile: actualCopyFile,
      existsSync,
      hardLink: actualLink,
      lstat: actualLstat,
      mkdir: actualMkdir,
      osHomedir: () => t3Home,
      removeFile: actualUnlink,
      removePath: actualRm,
      repoRoot,
      runGit: async (args, cwd) => {
        const { stdout } = await execFile("git", args, { cwd });
        return stdout.trim();
      },
      symlink: actualSymlink,
    });

    await runCli(["feature-rerun", "feature/rerun", "--copy-env"], deps);
    await expect(runCli(["feature-rerun", "feature/rerun", "--copy-env"], deps)).resolves.toBeUndefined();

    const worktreePath = getWorktreePath("feature-rerun", deps);
    expect(existsSync(path.join(worktreePath, ".git"))).toBe(true);
  });

  it("cleans up an orphaned destination folder before creating the worktree", async () => {
    const { repoRoot, tempRoot } = await createTempRepo();
    tempRoots.push(tempRoot);
    await writeFile(path.join(repoRoot, ".env.local"), "API_URL=http://example.test\n", "utf8");

    const t3Home = path.join(tempRoot, "home");
    const actualCopyFile = (await import("node:fs/promises")).copyFile;
    const actualLink = (await import("node:fs/promises")).link;
    const actualLstat = (await import("node:fs/promises")).lstat;
    const actualMkdir = (await import("node:fs/promises")).mkdir;
    const actualRm = (await import("node:fs/promises")).rm;
    const actualSymlink = (await import("node:fs/promises")).symlink;
    const actualUnlink = (await import("node:fs/promises")).unlink;

    const deps = createDeps({
      copyFile: actualCopyFile,
      existsSync,
      hardLink: actualLink,
      lstat: actualLstat,
      mkdir: actualMkdir,
      osHomedir: () => t3Home,
      removeFile: actualUnlink,
      removePath: actualRm,
      repoRoot,
      runGit: async (args, cwd) => {
        const { stdout } = await execFile("git", args, { cwd });
        return stdout.trim();
      },
      symlink: actualSymlink,
    });

    const orphanedPath = getWorktreePath("feature-orphaned", deps);
    await mkdir(orphanedPath, { recursive: true });
    await writeFile(path.join(orphanedPath, "stale.txt"), "stale\n", "utf8");

    await runCli(["feature-orphaned", "feature/orphaned", "--copy-env"], deps);

    expect(existsSync(path.join(orphanedPath, ".git"))).toBe(true);
    expect(existsSync(path.join(orphanedPath, "stale.txt"))).toBe(false);
  });

  it("fails with a clear error when the branch already exists in another worktree", async () => {
    const { repoRoot, tempRoot } = await createTempRepo();
    tempRoots.push(tempRoot);
    await writeFile(path.join(repoRoot, ".env.local"), "API_URL=http://example.test\n", "utf8");

    const firstWorktreePath = path.join(tempRoot, "existing-worktree");
    await execFile("git", ["worktree", "add", "-b", "feature/shared", firstWorktreePath, "main"], { cwd: repoRoot });

    const t3Home = path.join(tempRoot, "home");
    const actualCopyFile = (await import("node:fs/promises")).copyFile;
    const actualLink = (await import("node:fs/promises")).link;
    const actualLstat = (await import("node:fs/promises")).lstat;
    const actualMkdir = (await import("node:fs/promises")).mkdir;
    const actualRm = (await import("node:fs/promises")).rm;
    const actualSymlink = (await import("node:fs/promises")).symlink;
    const actualUnlink = (await import("node:fs/promises")).unlink;

    const deps = createDeps({
      copyFile: actualCopyFile,
      existsSync,
      hardLink: actualLink,
      lstat: actualLstat,
      mkdir: actualMkdir,
      osHomedir: () => t3Home,
      removeFile: actualUnlink,
      removePath: actualRm,
      repoRoot,
      runGit: async (args, cwd) => {
        const { stdout } = await execFile("git", args, { cwd });
        return stdout.trim();
      },
      symlink: actualSymlink,
    });

    await expect(runCli(["feature-conflict", "feature/shared", "--copy-env"], deps)).rejects.toThrow(
      "Branch feature/shared is already checked out at",
    );
  });
});
