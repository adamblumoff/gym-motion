import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { uploadFirmwareObject } from "@/lib/storage-bucket";

const apiBaseUrl = process.env.API_URL ?? "https://gym-motion-production.up.railway.app";

function readArg(name: string) {
  const index = process.argv.indexOf(`--${name}`);

  if (index >= 0) {
    return process.argv[index + 1];
  }

  return undefined;
}

async function readChecksum(filePath: string) {
  const contents = await readFile(filePath, "utf8");
  return contents.trim().split(/\s+/)[0] ?? "";
}

async function resolveGitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

async function main() {
  const version = readArg("version");

  if (!version) {
    throw new Error("Missing required --version argument.");
  }

  const rolloutState = readArg("rollout") ?? "active";
  const filePath = readArg("file") ?? "build/firmware/gym_motion.ino.bin";
  const shaFile = readArg("sha") ?? `${filePath}.sha256`;
  const md5File = readArg("md5") ?? `${filePath}.md5`;
  const objectKey = `reference-node-firmware/${version}/gym_motion.ino.bin`;
  const gitSha = await resolveGitSha();

  const upload = await uploadFirmwareObject({
    filePath,
    objectKey,
  });

  const payload = {
    version,
    gitSha,
    assetUrl: objectKey,
    sha256: await readChecksum(shaFile),
    md5: await readChecksum(md5File),
    sizeBytes: upload.sizeBytes,
    rolloutState,
  };

  const response = await fetch(`${apiBaseUrl}/api/firmware/releases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Release registration failed with ${response.status}: ${await response.text()}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        artifactType: "reference-ble-node-firmware",
        bucket: upload.bucketName,
        objectKey,
        apiBaseUrl,
        payload,
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
