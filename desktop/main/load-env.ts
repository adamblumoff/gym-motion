import path from "node:path";
import { existsSync } from "node:fs";

import { config as loadDotenv } from "dotenv";

type EnvLoadResult = {
  loadedFiles: string[];
};

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((filePath) => path.resolve(filePath)))];
}

function candidateEnvFiles() {
  const repoRoot = process.cwd();
  const executableDir = path.dirname(process.execPath);
  const resourcesDir = process.resourcesPath;

  return uniquePaths([
    path.join(repoRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(executableDir, ".env"),
    path.join(executableDir, ".env.local"),
    path.join(resourcesDir, ".env"),
    path.join(resourcesDir, ".env.local"),
  ]);
}

export function loadDesktopEnv(): EnvLoadResult {
  const loadedFiles: string[] = [];

  for (const filePath of candidateEnvFiles()) {
    if (!existsSync(filePath)) {
      continue;
    }

    const result = loadDotenv({
      path: filePath,
      override: true,
    });

    if (result.error) {
      throw result.error;
    }

    loadedFiles.push(filePath);
  }

  return { loadedFiles };
}
