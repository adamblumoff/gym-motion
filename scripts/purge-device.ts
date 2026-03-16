import { purgeDeviceData } from "../backend/data";
import { loadRepoEnv } from "./load-env";

loadRepoEnv();

function printHelp() {
  console.log(`Usage: bun run scripts/purge-device.ts [device-id]

Arguments:
  device-id   Device id to purge (default: stack-001)
`);
}

async function main() {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const deviceId = process.argv[2] ?? process.env.DEVICE_ID ?? "stack-001";
  const result = await purgeDeviceData(deviceId);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Failed to purge device data.", error);
  process.exit(1);
});
