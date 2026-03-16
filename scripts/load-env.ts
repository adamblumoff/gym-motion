import { existsSync } from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ENV_FILES = [".env.local", ".env"];

export function loadRepoEnv() {
  for (const filename of ENV_FILES) {
    const envPath = path.join(REPO_ROOT, filename);

    if (!existsSync(envPath)) {
      continue;
    }

    dotenv.config({
      path: envPath,
      override: false,
    });
  }
}
