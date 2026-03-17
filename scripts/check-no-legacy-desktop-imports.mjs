import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

const checks = [
  {
    label: "desktop core wrapper imports",
    args: [
      "rg",
      "-n",
      'from ["\'](?:\\.\\.?/)*data["\']|from ["\'](?:\\.\\.?/)*use-desktop-app["\']|from ["\']desktop/core/',
      "desktop",
      "shared",
      "--glob",
      "!desktop/core/**/*.test.ts",
      "--glob",
      "!release/**",
      "--glob",
      "!dist/**",
    ],
  },
  {
    label: "legacy bench dependencies",
    args: [
      "rg",
      "-n",
      "@abandonware/noble|@abandonware/bluetooth-hci-socket|NOBLE_HCI_DEVICE_ID",
      "desktop",
      "shared",
      "--glob",
      "!release/**",
      "--glob",
      "!dist/**",
    ],
  },
];

let failed = false;

for (const check of checks) {
  const command = spawnSync(check.args[0], check.args.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const stdout = command.stdout ?? "";
  const stderr = command.stderr ?? "";
  const exitCode = command.status ?? 1;

  if (exitCode === 0 && stdout.trim().length > 0) {
    failed = true;
    console.error(`Found forbidden ${check.label}:`);
    console.error(stdout.trim());
    continue;
  }

  if (exitCode > 1) {
    failed = true;
    console.error(`Failed to run check for ${check.label}:`);
    console.error(stderr.trim() || stdout.trim());
  }
}

if (failed) {
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const dependencySections = [
  packageJson.dependencies ?? {},
  packageJson.devDependencies ?? {},
  packageJson.optionalDependencies ?? {},
];

for (const dependencyName of [
  "@abandonware/noble",
  "@abandonware/bluetooth-hci-socket",
  "usb",
]) {
  if (dependencySections.some((section) => dependencyName in section)) {
    console.error(`Found forbidden legacy bench dependency in package.json: ${dependencyName}`);
    process.exit(1);
  }
}
