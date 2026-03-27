import { spawn } from "node:child_process";

import {
  appendDevLog,
  createDevRunnerEnv,
  detectWorktreeContext,
  ensureDevHomeLayout,
  isDevRunnerMode,
  resolveDevHome,
  resolveDevHomePaths,
  resolveDevPorts,
  type DevRunnerMode,
  type DevHomePaths,
} from "./dev-env-config";
import { writeDevState } from "./dev-env-config";

export type DevRunnerCliOptions = {
  mode: DevRunnerMode;
  dryRun: boolean;
  turboArgs: string[];
};

export function parseDevRunnerArgs(argv: string[]): DevRunnerCliOptions {
  const [modeArg, ...rest] = argv;

  if (!modeArg || !isDevRunnerMode(modeArg)) {
    throw new Error(
      `Expected one of: ${["dev", "dev:desktop", "dev:runtime", "dev:ble-sidecar", "dev:test-desktop"].join(", ")}`,
    );
  }

  const turboArgs: string[] = [];
  let dryRun = false;

  for (const argument of rest) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }

    turboArgs.push(argument);
  }

  return {
    mode: modeArg,
    dryRun,
    turboArgs,
  };
}

function logLine(category: string, message: string) {
  console.log(`[${category}] ${message}`);
}

async function logWithPersistence(paths: DevHomePaths, category: string, message: string) {
  logLine(category, message);
  await appendDevLog(paths, category, message);
}

export function turboCommandArgs(mode: DevRunnerMode, turboArgs: string[] = []): string[] {
  return ["turbo", "run", mode, "--ui=tui", ...turboArgs];
}

async function spawnTurbo(mode: DevRunnerMode, env: NodeJS.ProcessEnv, turboArgs: string[]) {
  const args = turboCommandArgs(mode, turboArgs);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bunx", args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env,
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Turbo exited with code ${code ?? "null"} signal ${signal ?? "null"}.`));
    });

    child.once("error", (error) => {
      reject(error);
    });
  });
}

export async function runDevRunner(options: DevRunnerCliOptions): Promise<void> {
  const cwd = process.cwd();
  const devHome = resolveDevHome(process.env);
  const paths = resolveDevHomePaths(devHome);
  await ensureDevHomeLayout(paths);

  const ports = await resolveDevPorts(process.env);
  const worktree = detectWorktreeContext(cwd);
  const env = createDevRunnerEnv({
    baseEnv: process.env,
    devHome,
    mode: options.mode,
    ports,
    cwd,
  });

  const state = {
    cwd,
    mode: options.mode,
    rendererPort: ports.rendererPort,
    runtimePort: ports.runtimePort,
    startedAt: new Date().toISOString(),
    instanceId: process.env.GYM_MOTION_DEV_INSTANCE?.trim() || null,
    isWorktree: worktree.isWorktree,
    ...(worktree.worktreeName ? { worktreeName: worktree.worktreeName } : {}),
  };

  await writeDevState(paths, state);

  const executionSummary = turboCommandArgs(options.mode, options.turboArgs).join(" ");
  const portModeSummary = [
    ports.rendererPortExplicit ? "renderer explicit" : "renderer auto",
    ports.runtimePortExplicit ? "runtime explicit" : "runtime auto",
  ].join(", ");

  await logWithPersistence(paths, "dev-runner", `mode=${options.mode}`);
  await logWithPersistence(paths, "ports", `renderer=${ports.rendererPort} runtime=${ports.runtimePort}`);
  await logWithPersistence(paths, "ports", `selection=${ports.source} offset=${ports.offset} (${portModeSummary})`);
  await logWithPersistence(paths, "state", `cwd=${cwd}`);
  await logWithPersistence(paths, "state", `devHome=${devHome}`);
  await logWithPersistence(
    paths,
    "state",
    worktree.isWorktree
      ? `worktree=true name=${worktree.worktreeName ?? "unknown"}`
      : "worktree=false",
  );
  await logWithPersistence(paths, "task", `command=${executionSummary}`);

  if (options.dryRun) {
    await logWithPersistence(paths, "dev-runner", "dry-run requested, skipping turbo execution");
    return;
  }

  await spawnTurbo(options.mode, env, options.turboArgs);
}

export async function runDevRunnerCli(argv: string[]): Promise<void> {
  const options = parseDevRunnerArgs(argv);
  await runDevRunner(options);
}

if (import.meta.main) {
  runDevRunnerCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
