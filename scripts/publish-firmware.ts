import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { createFirmwareRelease } from "../backend/data/repository";
import { uploadFirmwareObject } from "../backend/storage-bucket";
import { loadRepoEnv } from "./load-env";

loadRepoEnv();

function readArg(name: string) {
  const index = process.argv.indexOf(`--${name}`);

  if (index >= 0) {
    return process.argv[index + 1];
  }

  return undefined;
}

function printHelp() {
  console.log(`Usage: bun run scripts/publish-firmware.ts --version <semver> [options]

Options:
  --version <value>   Required firmware version to register
  --rollout <state>   Rollout state: draft | active | paused (default: active)
  --file <path>       Firmware binary path (default: build/firmware/gym_motion.ino.bin)
  --sha <path>        SHA256 checksum file path
  --md5 <path>        MD5 checksum file path
`);
}

async function readChecksum(filePath: string) {
  const contents = await readFile(filePath, "utf8");
  return contents.trim().split(/\s+/)[0] ?? "";
}

function resolveGitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

async function main() {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const version = readArg("version");

  if (!version) {
    throw new Error("Missing required --version argument.");
  }

  const rolloutState = readArg("rollout") ?? "active";
  const filePath = readArg("file") ?? "build/firmware/gym_motion.ino.bin";
  const shaFile = readArg("sha") ?? `${filePath}.sha256`;
  const md5File = readArg("md5") ?? `${filePath}.md5`;
  const objectKey = `reference-node-firmware/${version}/gym_motion.ino.bin`;
  const gitSha = resolveGitSha();

  const upload = await uploadFirmwareObject({
    filePath,
    objectKey,
  });

  const release = await createFirmwareRelease({
    version,
    gitSha,
    assetUrl: objectKey,
    sha256: await readChecksum(shaFile),
    md5: await readChecksum(md5File),
    sizeBytes: upload.sizeBytes,
    rolloutState:
      rolloutState === "draft" || rolloutState === "paused" ? rolloutState : "active",
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        artifactType: "reference-ble-node-firmware",
        bucket: upload.bucketName,
        objectKey,
        release,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to publish firmware.", error);
  process.exit(1);
});
