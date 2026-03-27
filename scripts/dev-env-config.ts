import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

import { z } from "zod";

export const DEV_RUNNER_MODES = [
  "dev",
  "dev:desktop",
  "dev:runtime",
  "dev:ble-sidecar",
  "dev:test-desktop",
] as const;

export type DevRunnerMode = (typeof DEV_RUNNER_MODES)[number];

export const BASE_RENDERER_PORT = 5733;
export const BASE_RUNTIME_PORT = 4010;
const MAX_PORT = 65_535;
const MAX_HASH_OFFSET = 3_000;
const WORKTREE_SEGMENTS = [".t3", "worktrees", "gym-motion"] as const;

export type ResolvedDevPorts = {
  rendererPort: number;
  runtimePort: number;
  offset: number;
  source: string;
  rendererPortExplicit: boolean;
  runtimePortExplicit: boolean;
};

export type DevRunnerEnv = NodeJS.ProcessEnv & {
  GYM_MOTION_DEV_HOME: string;
  GYM_MOTION_RENDERER_PORT: string;
  GYM_MOTION_RUNTIME_PORT: string;
  GYM_MOTION_DEV_URL: string;
  GYM_MOTION_AUTO_BOOTSTRAP_FROM_CWD: string;
  GYM_MOTION_DEV_RUNNER_ACTIVE: string;
  GYM_MOTION_DEV_RUNNER_MODE: DevRunnerMode;
  PORT: string;
  ELECTRON_RENDERER_PORT: string;
};

export const DevInstanceStateSchema = z.object({
  cwd: z.string().min(1),
  mode: z.enum(DEV_RUNNER_MODES),
  rendererPort: z.number().int().positive(),
  runtimePort: z.number().int().positive(),
  startedAt: z.string().min(1),
  instanceId: z.string().min(1).nullable(),
  isWorktree: z.boolean(),
  worktreeName: z.string().min(1).optional(),
});

export type DevInstanceState = z.infer<typeof DevInstanceStateSchema>;

export type DevHomePaths = {
  rootDir: string;
  settingsPath: string;
  keybindingsPath: string;
  logsDir: string;
  devRunnerLogPath: string;
  taskLogsDir: string;
  attachmentsDir: string;
  statePath: string;
};

export type WorktreeContext = {
  isWorktree: boolean;
  worktreeName?: string;
};

export type OffsetResolution = {
  offset: number;
  source: string;
};

type PortAvailabilityCheck = (port: number) => Promise<boolean>;

export function isDevRunnerMode(value: string): value is DevRunnerMode {
  return DEV_RUNNER_MODES.includes(value as DevRunnerMode);
}

export function resolveDevHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir = os.homedir(),
): string {
  const configured = env.GYM_MOTION_DEV_HOME?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  if (platform === "win32") {
    return path.join(homeDir, ".gym-motion-dev");
  }

  return path.posix.join(homeDir, ".gym-motion-dev");
}

export function resolveDevHomePaths(rootDir: string): DevHomePaths {
  const logsDir = path.join(rootDir, "logs");
  return {
    rootDir,
    settingsPath: path.join(rootDir, "settings.json"),
    keybindingsPath: path.join(rootDir, "keybindings.json"),
    logsDir,
    devRunnerLogPath: path.join(logsDir, "dev-runner.log"),
    taskLogsDir: path.join(logsDir, "tasks"),
    attachmentsDir: path.join(rootDir, "attachments"),
    statePath: path.join(rootDir, "state.json"),
  };
}

export async function ensureDevHomeLayout(paths: DevHomePaths): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.taskLogsDir, { recursive: true });
  await mkdir(paths.attachmentsDir, { recursive: true });
  await ensureJsonFile(paths.settingsPath, {});
  await ensureJsonFile(paths.keybindingsPath, {});
}

async function ensureJsonFile(filePath: string, fallbackValue: unknown): Promise<void> {
  if (existsSync(filePath)) {
    return;
  }

  await writeFile(filePath, `${JSON.stringify(fallbackValue, null, 2)}\n`, "utf8");
}

export async function writeDevState(paths: DevHomePaths, state: DevInstanceState): Promise<void> {
  await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readDevState(paths: DevHomePaths): Promise<DevInstanceState | null> {
  try {
    const raw = await readFile(paths.statePath, "utf8");
    return DevInstanceStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function appendDevLog(paths: DevHomePaths, category: string, message: string): Promise<void> {
  await mkdir(paths.logsDir, { recursive: true });
  const line = `${new Date().toISOString()} [${category}] ${message}\n`;
  await writeFile(paths.devRunnerLogPath, line, { encoding: "utf8", flag: "a" });
}

export async function appendTaskLog(
  paths: DevHomePaths,
  mode: DevRunnerMode,
  message: string,
): Promise<void> {
  await mkdir(paths.taskLogsDir, { recursive: true });
  const safeMode = mode.replace(/[^a-z0-9-:]+/gi, "-").replace(/:/g, "__");
  const line = `${new Date().toISOString()} ${message}\n`;
  await writeFile(path.join(paths.taskLogsDir, `${safeMode}.log`), line, {
    encoding: "utf8",
    flag: "a",
  });
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer value: ${value}`);
  }

  return parsed;
}

export function resolveOffset(env: NodeJS.ProcessEnv = process.env): OffsetResolution {
  const explicitOffset = parseOptionalInteger(env.GYM_MOTION_PORT_OFFSET);
  if (explicitOffset !== undefined) {
    return {
      offset: explicitOffset,
      source: `GYM_MOTION_PORT_OFFSET=${explicitOffset}`,
    };
  }

  const instanceId = env.GYM_MOTION_DEV_INSTANCE?.trim();
  if (!instanceId) {
    return {
      offset: 0,
      source: "default ports",
    };
  }

  if (/^\d+$/.test(instanceId)) {
    return {
      offset: Number(instanceId),
      source: `numeric GYM_MOTION_DEV_INSTANCE=${instanceId}`,
    };
  }

  const digest = createHash("sha1").update(instanceId).digest("hex");
  const numericDigest = Number.parseInt(digest.slice(0, 8), 16);
  return {
    offset: (numericDigest % MAX_HASH_OFFSET) + 1,
    source: `hashed GYM_MOTION_DEV_INSTANCE=${instanceId}`,
  };
}

async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function resolveDevPorts(
  env: NodeJS.ProcessEnv = process.env,
  checkPortAvailability: PortAvailabilityCheck = isLoopbackPortAvailable,
): Promise<ResolvedDevPorts> {
  const { offset: startOffset, source } = resolveOffset(env);
  const explicitRendererPort = parseOptionalInteger(env.GYM_MOTION_RENDERER_PORT);
  const explicitRuntimePort = parseOptionalInteger(env.GYM_MOTION_RUNTIME_PORT);

  for (let offset = startOffset; offset <= MAX_PORT; offset += 1) {
    const rendererPort = explicitRendererPort ?? BASE_RENDERER_PORT + offset;
    const runtimePort = explicitRuntimePort ?? BASE_RUNTIME_PORT + offset;

    if (rendererPort > MAX_PORT || runtimePort > MAX_PORT) {
      break;
    }

    const rendererAvailable = explicitRendererPort !== undefined
      ? true
      : await checkPortAvailability(rendererPort);
    if (!rendererAvailable) {
      continue;
    }

    const runtimeAvailable = explicitRuntimePort !== undefined
      ? true
      : await checkPortAvailability(runtimePort);
    if (!runtimeAvailable) {
      continue;
    }

    return {
      rendererPort,
      runtimePort,
      offset,
      source,
      rendererPortExplicit: explicitRendererPort !== undefined,
      runtimePortExplicit: explicitRuntimePort !== undefined,
    };
  }

  throw new Error(
    `No available renderer/runtime port pair found from offset ${startOffset}.`,
  );
}

export function detectWorktreeContext(cwd: string): WorktreeContext {
  const normalized = path.resolve(cwd);
  const segments = normalized.split(/[\\/]+/).filter(Boolean);

  for (let index = 0; index <= segments.length - WORKTREE_SEGMENTS.length; index += 1) {
    const matches = WORKTREE_SEGMENTS.every((segment, segmentIndex) => {
      return segments[index + segmentIndex]?.toLowerCase() === segment.toLowerCase();
    });

    if (!matches) {
      continue;
    }

    const worktreeName = segments[index + WORKTREE_SEGMENTS.length];
    if (worktreeName) {
      return {
        isWorktree: true,
        worktreeName,
      };
    }
  }

  return { isWorktree: false };
}

export function createDevRunnerEnv(input: {
  baseEnv?: NodeJS.ProcessEnv;
  devHome: string;
  mode: DevRunnerMode;
  ports: ResolvedDevPorts;
  cwd?: string;
}): DevRunnerEnv {
  const baseEnv = input.baseEnv ?? process.env;
  const nextEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    GYM_MOTION_DEV_HOME: input.devHome,
    GYM_MOTION_RENDERER_PORT: String(input.ports.rendererPort),
    GYM_MOTION_RUNTIME_PORT: String(input.ports.runtimePort),
    GYM_MOTION_DEV_URL: `http://localhost:${input.ports.rendererPort}/`,
    GYM_MOTION_DEV_RUNNER_ACTIVE: "1",
    GYM_MOTION_DEV_RUNNER_MODE: input.mode,
    PORT: String(input.ports.rendererPort),
    ELECTRON_RENDERER_PORT: String(input.ports.rendererPort),
  };

  delete nextEnv.ELECTRON_RUN_AS_NODE;
  delete nextEnv.ELECTRON_NO_ATTACH_CONSOLE;

  if (!nextEnv.GYM_MOTION_AUTO_BOOTSTRAP_FROM_CWD) {
    nextEnv.GYM_MOTION_AUTO_BOOTSTRAP_FROM_CWD = "1";
  }

  if (input.mode === "dev:test-desktop") {
    nextEnv.GYM_MOTION_E2E = "1";
  }

  if (input.cwd) {
    nextEnv.GYM_MOTION_PROJECT_CWD = input.cwd;
  }

  return nextEnv as DevRunnerEnv;
}
