import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["backend", "desktop"];
const FILE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx"]);
const FORBIDDEN_PATTERNS = [
  /from\s+["'][^"']*legacy[^"']*["']/g,
  /import\s*\(\s*["'][^"']*legacy[^"']*["']\s*\)/g,
  /require\s*\(\s*["'][^"']*legacy[^"']*["']\s*\)/g,
  /from\s+["']@\/lib\//g,
  /import\s*\(\s*["']@\/lib\//g,
  /require\s*\(\s*["']@\/lib\//g,
];

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
      continue;
    }

    if (FILE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  const violations = [];

  for (const relativeDir of SCAN_DIRS) {
    const fullDir = path.join(ROOT, relativeDir);
    const files = await walk(fullDir);

    for (const file of files) {
      const source = await fs.readFile(file, "utf8");

      for (const pattern of FORBIDDEN_PATTERNS) {
        pattern.lastIndex = 0;

        if (pattern.test(source)) {
          violations.push(path.relative(ROOT, file));
          break;
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error("Forbidden legacy imports found in desktop/backend code:");
    for (const file of violations) {
      console.error(`- ${file}`);
    }
    process.exit(1);
  }
}

await main();
