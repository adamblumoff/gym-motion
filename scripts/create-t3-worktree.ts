import { copyFile, link, lstat, mkdir, rm, symlink, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceEnvFilename = ".env.local";
const t3RepoDirectoryName = "gym-motion";

export type CliOptions = {
  baseRef: string;
  branchName: string;
  copyEnv: boolean;
  forceEnv: boolean;
  pathOnly: boolean;
  worktreeName: string;
};

export type EnvProvisionMode = "copy" | "hardlink" | "symlink";

export type EnvProvisionResult = {
  mode: EnvProvisionMode;
  warning?: string;
};

type ExistingEnvProvisionResult = {
  mode: "existing";
  warning?: string;
};

type WorktreeEntry = {
  branchName?: string;
  detached: boolean;
  path: string;
  prunable: boolean;
};

export type RuntimeDependencies = {
  copyFile: typeof copyFile;
  existsSync: typeof existsSync;
  hardLink: typeof link;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  osHomedir: typeof os.homedir;
  removeFile: typeof unlink;
  removePath: typeof rm;
  repoRoot: string;
  runGit: (args: string[], cwd: string) => Promise<string>;
  symlink: typeof symlink;
};

const runtimeDependencies: RuntimeDependencies = {
  copyFile,
  existsSync,
  hardLink: link,
  lstat,
  mkdir,
  osHomedir: os.homedir,
  removeFile: unlink,
  removePath: rm,
  repoRoot,
  runGit: async (args, cwd) => {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  },
  symlink,
};

function usage() {
  return [
    "Usage:",
    "  bun run worktree:create:t3 -- <worktree-name> <branch-name> [--base <ref>] [--force-env] [--copy-env] [--path-only]",
  ].join("\n");
}

function normalizePathForComparison(targetPath: string) {
  const resolvedPath = path.resolve(targetPath);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function parseWorktreeRef(line: string) {
  const prefix = "branch ";

  if (!line.startsWith(prefix)) {
    return undefined;
  }

  const ref = line.slice(prefix.length);
  const headPrefix = "refs/heads/";

  return ref.startsWith(headPrefix) ? ref.slice(headPrefix.length) : undefined;
}

function parseWorktreeList(porcelainOutput: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let currentEntry: WorktreeEntry | null = null;

  for (const line of porcelainOutput.split(/\r?\n/)) {
    if (!line) {
      if (currentEntry) {
        entries.push(currentEntry);
        currentEntry = null;
      }
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (currentEntry) {
        entries.push(currentEntry);
      }

      currentEntry = {
        detached: false,
        path: line.slice("worktree ".length),
        prunable: false,
      };
      continue;
    }

    if (!currentEntry) {
      continue;
    }

    if (line.startsWith("branch ")) {
      currentEntry.branchName = parseWorktreeRef(line);
      continue;
    }

    if (line === "detached") {
      currentEntry.detached = true;
      continue;
    }

    if (line.startsWith("prunable")) {
      currentEntry.prunable = true;
    }
  }

  if (currentEntry) {
    entries.push(currentEntry);
  }

  return entries;
}

async function listGitWorktrees(deps: Pick<RuntimeDependencies, "repoRoot" | "runGit">) {
  const output = await deps.runGit(["worktree", "list", "--porcelain"], deps.repoRoot);
  return parseWorktreeList(output);
}

function findWorktreeByPath(worktrees: WorktreeEntry[], worktreePath: string) {
  const normalizedTargetPath = normalizePathForComparison(worktreePath);
  return worktrees.find(
    (worktree) => normalizePathForComparison(worktree.path) === normalizedTargetPath,
  );
}

function findWorktreeByBranch(worktrees: WorktreeEntry[], branchName: string) {
  return worktrees.find((worktree) => worktree.branchName === branchName);
}

export function parseCliArgs(argv: string[]): CliOptions {
  let baseRef = "main";
  let copyEnv = false;
  let forceEnv = false;
  let pathOnly = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--base": {
        const nextValue = argv[index + 1];

        if (!nextValue) {
          throw new Error("--base requires a ref value.");
        }

        baseRef = nextValue;
        index += 1;
        break;
      }
      case "--copy-env":
        copyEnv = true;
        break;
      case "--force-env":
        forceEnv = true;
        break;
      case "--path-only":
        pathOnly = true;
        break;
      default:
        if (argument.startsWith("--")) {
          throw new Error(`Unknown option: ${argument}`);
        }
        positional.push(argument);
        break;
    }
  }

  if (positional.length !== 2) {
    throw new Error("Expected <worktree-name> and <branch-name>.");
  }

  return {
    baseRef,
    branchName: positional[1],
    copyEnv,
    forceEnv,
    pathOnly,
    worktreeName: positional[0],
  };
}

export function getT3WorktreeRoot(deps: Pick<RuntimeDependencies, "osHomedir"> = runtimeDependencies) {
  return path.join(deps.osHomedir(), ".t3", "worktrees", t3RepoDirectoryName);
}

export function getWorktreePath(
  worktreeName: string,
  deps: Pick<RuntimeDependencies, "osHomedir"> = runtimeDependencies,
) {
  return path.join(getT3WorktreeRoot(deps), worktreeName);
}

export function getSourceEnvPath(deps: Pick<RuntimeDependencies, "repoRoot"> = runtimeDependencies) {
  return path.join(deps.repoRoot, sourceEnvFilename);
}

async function pathExists(filePath: string, deps: Pick<RuntimeDependencies, "lstat">) {
  try {
    await deps.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureEnvTargetWritable(
  targetEnvPath: string,
  options: Pick<CliOptions, "forceEnv">,
  deps: Pick<RuntimeDependencies, "lstat" | "removeFile" | "removePath">,
) {
  if (!(await pathExists(targetEnvPath, deps))) {
    return;
  }

  if (!options.forceEnv) {
    throw new Error(
      `Refusing to overwrite existing ${sourceEnvFilename} at ${targetEnvPath}. Re-run with --force-env to replace it.`,
    );
  }

  const stats = await deps.lstat(targetEnvPath);

  if (stats.isDirectory()) {
    await deps.removePath(targetEnvPath, { force: true, recursive: true });
    return;
  }

  await deps.removeFile(targetEnvPath);
}

async function tryCreateSymlink(sourceEnvPath: string, targetEnvPath: string, deps: RuntimeDependencies) {
  await deps.symlink(sourceEnvPath, targetEnvPath, "file");
  return "symlink" as const;
}

async function tryCreateHardLink(sourceEnvPath: string, targetEnvPath: string, deps: RuntimeDependencies) {
  await deps.hardLink(sourceEnvPath, targetEnvPath);
  return "hardlink" as const;
}

export async function provisionEnvFile(
  sourceEnvPath: string,
  targetEnvPath: string,
  options: Pick<CliOptions, "copyEnv" | "forceEnv">,
  deps: RuntimeDependencies = runtimeDependencies,
): Promise<EnvProvisionResult> {
  await ensureEnvTargetWritable(targetEnvPath, options, deps);

  if (options.copyEnv) {
    await deps.copyFile(sourceEnvPath, targetEnvPath);
    return {
      mode: "copy",
      warning: "requested copy mode is not live-synced",
    };
  }

  try {
    return { mode: await tryCreateSymlink(sourceEnvPath, targetEnvPath, deps) };
  } catch (symlinkError) {
    try {
      return {
        mode: await tryCreateHardLink(sourceEnvPath, targetEnvPath, deps),
        warning: `symlink fallback: ${formatErrorMessage(symlinkError)}`,
      };
    } catch (hardLinkError) {
      await deps.copyFile(sourceEnvPath, targetEnvPath);
      return {
        mode: "copy",
        warning: `copy fallback is not live-synced; symlink error: ${formatErrorMessage(
          symlinkError,
        )}; hardlink error: ${formatErrorMessage(hardLinkError)})`,
      };
    }
  }
}

async function ensureEnvFile(
  sourceEnvPath: string,
  targetEnvPath: string,
  options: Pick<CliOptions, "copyEnv" | "forceEnv">,
  deps: RuntimeDependencies = runtimeDependencies,
): Promise<EnvProvisionResult | ExistingEnvProvisionResult> {
  if ((await pathExists(targetEnvPath, deps)) && !options.forceEnv) {
    return {
      mode: "existing",
      warning: `kept existing ${sourceEnvFilename} at ${targetEnvPath}; re-run with --force-env to replace it.`,
    };
  }

  return provisionEnvFile(sourceEnvPath, targetEnvPath, options, deps);
}

async function gitBranchExists(branchName: string, deps: RuntimeDependencies) {
  try {
    await deps.runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], deps.repoRoot);
    return true;
  } catch {
    return false;
  }
}

export async function createGitWorktree(
  worktreePath: string,
  options: Pick<CliOptions, "baseRef" | "branchName">,
  deps: RuntimeDependencies = runtimeDependencies,
) {
  const branchExists = await gitBranchExists(options.branchName, deps);
  const args = branchExists
    ? ["worktree", "add", worktreePath, options.branchName]
    : ["worktree", "add", "-b", options.branchName, worktreePath, options.baseRef];

  await deps.runGit(args, deps.repoRoot);

  return { branchExists };
}

export async function cleanupWorktree(
  worktreePath: string,
  deps: Pick<RuntimeDependencies, "removePath" | "runGit" | "repoRoot"> = runtimeDependencies,
) {
  try {
    await deps.runGit(["worktree", "remove", "--force", worktreePath], deps.repoRoot);
  } catch {
    await deps.removePath(worktreePath, { force: true, recursive: true });
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function prepareWorktreeDestination(
  worktreePath: string,
  deps: Pick<RuntimeDependencies, "existsSync" | "removePath" | "repoRoot" | "runGit">,
) {
  await deps.runGit(["worktree", "prune"], deps.repoRoot);

  const worktrees = await listGitWorktrees(deps);
  const existingWorktree = findWorktreeByPath(worktrees, worktreePath);

  if (deps.existsSync(worktreePath) && !existingWorktree) {
    await deps.removePath(worktreePath, { force: true, recursive: true });
    return { reusedExistingWorktree: false, worktrees };
  }

  return {
    reusedExistingWorktree: Boolean(existingWorktree),
    worktrees,
  };
}

export async function runCli(
  argv: string[],
  deps: RuntimeDependencies = runtimeDependencies,
) {
  const options = parseCliArgs(argv);
  const worktreePath = getWorktreePath(options.worktreeName, deps);
  const sourceEnvPath = getSourceEnvPath(deps);

  if (options.pathOnly) {
    console.log(worktreePath);
    return;
  }

  if (!deps.existsSync(sourceEnvPath)) {
    throw new Error(`Missing source ${sourceEnvFilename} at ${sourceEnvPath}.`);
  }

  await deps.mkdir(path.dirname(worktreePath), { recursive: true });

  const destinationPrep = await prepareWorktreeDestination(worktreePath, deps);
  const existingWorktree = findWorktreeByPath(destinationPrep.worktrees, worktreePath);
  const branchWorktree = findWorktreeByBranch(destinationPrep.worktrees, options.branchName);

  if (branchWorktree && !existingWorktree) {
    throw new Error(
      `Branch ${options.branchName} is already checked out at ${branchWorktree.path}. Reuse that worktree or choose a different branch name.`,
    );
  }

  if (existingWorktree && existingWorktree.branchName && existingWorktree.branchName !== options.branchName) {
    throw new Error(
      `Destination already exists as worktree ${worktreePath} on branch ${existingWorktree.branchName}. Choose a different worktree name or branch.`,
    );
  }

  if (existingWorktree && existingWorktree.detached) {
    throw new Error(`Destination already exists as detached worktree ${worktreePath}. Resolve it manually before reusing this name.`);
  }

  let worktreeCreated = false;

  try {
    if (!existingWorktree) {
      await createGitWorktree(worktreePath, options, deps);
      worktreeCreated = true;
    }

    const envProvision = await ensureEnvFile(
      sourceEnvPath,
      path.join(worktreePath, sourceEnvFilename),
      options,
      deps,
    );

    console.log(`worktree path: ${worktreePath}`);
    console.log(`env mode: ${envProvision.mode}`);

    if (envProvision.warning) {
      console.warn(envProvision.warning);
    }
  } catch (error) {
    if (worktreeCreated) {
      await cleanupWorktree(worktreePath, deps);
    }

    throw error;
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(formatErrorMessage(error));
    console.error(usage());
    process.exit(1);
  });
}
