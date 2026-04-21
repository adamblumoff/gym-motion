import { existsSync } from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

const REPO_ROOT = path.resolve(process.cwd());
const ENV_FILES = [".env.local", ".env"];

export function loadEnvFiles(envPaths: string[], options?: { override?: boolean }) {
  const loadedFiles: string[] = [];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) {
      continue;
    }

    dotenv.config({
      path: envPath,
      override: options?.override ?? false,
    });
    loadedFiles.push(envPath);
  }

  return { loadedFiles };
}

export function repoEnvFiles(repoRoot = REPO_ROOT) {
  return ENV_FILES.map((filename) => path.join(repoRoot, filename));
}

export function loadRepoEnv(repoRoot = REPO_ROOT) {
  return loadEnvFiles(repoEnvFiles(repoRoot), { override: false });
}
