import fs from "node:fs/promises";
import path from "node:path";

const MAX_LINES = 1000;
const ROOT = process.cwd();
const INCLUDE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".rs", ".ino"]);
const ALLOWED_OFFENDERS = new Set(["firmware/runtime_ble.ino"]);
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "out",
  "build",
  "release",
  "target",
  "vendor",
]);

async function walk(currentPath, files = []) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = path.relative(ROOT, absolutePath).split(path.sep).join("/");
    const segments = relativePath.split("/");

    if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
      continue;
    }

    if (entry.isDirectory()) {
      await walk(absolutePath, files);
      continue;
    }

    if (!INCLUDE_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }

    files.push({ absolutePath, relativePath });
  }

  return files;
}

async function lineCount(filePath) {
  const contents = await fs.readFile(filePath, "utf8");
  return contents.split("\n").length;
}

const files = await walk(ROOT);
const offenders = [];

for (const file of files) {
  const lines = await lineCount(file.absolutePath);

  if (lines > MAX_LINES && !ALLOWED_OFFENDERS.has(file.relativePath)) {
    offenders.push({ path: file.relativePath, lines });
  }
}

if (offenders.length > 0) {
  console.error(`Files over ${MAX_LINES} lines:`);
  for (const offender of offenders.toSorted((left, right) => right.lines - left.lines)) {
    console.error(`- ${offender.path}: ${offender.lines}`);
  }
  process.exit(1);
}
