import { spawn } from "node:child_process";

import { appendTaskLog, resolveDevHome, resolveDevHomePaths, type DevRunnerMode } from "./dev-env-config";
import { runDevRunnerCli } from "./dev-runner";

export type TaskExecutionPlan = {
  description: string;
  packageScript: string | null;
  env?: NodeJS.ProcessEnv;
};

function taskPlanForMode(mode: DevRunnerMode): TaskExecutionPlan {
  switch (mode) {
    case "dev":
    case "dev:desktop":
      return {
        description: "Launch the Gym Motion Electron desktop dev stack.",
        packageScript: "dev:desktop:task",
      };
    case "dev:test-desktop":
      return {
        description: "Launch the Electron desktop dev stack with desktop E2E mode enabled.",
        packageScript: "dev:test-desktop:task",
        env: {
          ...process.env,
          GYM_MOTION_E2E: "1",
        },
      };
    case "dev:runtime":
      return {
        description: "No standalone runtime-only dev loop exists yet. Leaving this as a no-op extension point.",
        packageScript: null,
      };
    case "dev:ble-sidecar":
      return {
        description:
          "Build the Windows BLE sidecar once. A dedicated watch mode is not implemented yet.",
        packageScript: "dev:ble-sidecar:task",
      };
  }
}

async function runPackageScript(packageScript: string, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["run", packageScript], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env,
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command exited with code ${code ?? "null"} signal ${signal ?? "null"}.`));
    });

    child.once("error", (error) => {
      reject(error);
    });
  });
}

export async function runTaskMode(mode: DevRunnerMode): Promise<void> {
  const devHome = resolveDevHome(process.env);
  const paths = resolveDevHomePaths(devHome);
  const plan = taskPlanForMode(mode);
  const env = plan.env ?? process.env;

  console.log(`[task] mode=${mode}`);
  console.log(`[task] ${plan.description}`);
  await appendTaskLog(paths, mode, `start ${plan.description}`);

  if (!plan.packageScript) {
    await appendTaskLog(paths, mode, "complete no-op");
    return;
  }

  console.log(`[task] executing bun run ${plan.packageScript}`);
  await appendTaskLog(paths, mode, `command bun run ${plan.packageScript}`);
  await runPackageScript(plan.packageScript, env);
  await appendTaskLog(paths, mode, "complete success");
}

export async function runDevEntryCli(argv: string[]): Promise<void> {
  const [modeArg, ...rest] = argv;
  if (
    modeArg !== "dev" &&
    modeArg !== "dev:desktop" &&
    modeArg !== "dev:runtime" &&
    modeArg !== "dev:ble-sidecar" &&
    modeArg !== "dev:test-desktop"
  ) {
    throw new Error(`Unknown dev mode: ${modeArg ?? "(missing)"}`);
  }

  if (process.env.GYM_MOTION_DEV_RUNNER_ACTIVE === "1") {
    await runTaskMode(modeArg);
    return;
  }

  await runDevRunnerCli([modeArg, ...rest]);
}

if (import.meta.main) {
  runDevEntryCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
