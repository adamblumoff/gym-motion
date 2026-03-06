import { purgeDeviceData } from "@/lib/repository";

async function main() {
  const deviceId = process.env.DEVICE_ID ?? "stack-001";
  const result = await purgeDeviceData(deviceId);

  console.log(result);
}

main().catch((error) => {
  console.error("Failed to purge device data.", error);
  process.exit(1);
});
