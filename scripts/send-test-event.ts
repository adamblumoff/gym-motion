function printHelp() {
  console.log(`Usage: bun run scripts/send-test-event.ts [options]

Options:
  --api-url <url>      API base URL (default: http://localhost:3000)
  --device-id <id>     Device id (default: stack-001)
`);
}

function readArg(name: string) {
  const index = process.argv.indexOf(`--${name}`);

  if (index >= 0) {
    return process.argv[index + 1];
  }

  return undefined;
}

async function main() {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const apiUrl = readArg("api-url") ?? process.env.API_URL ?? "http://localhost:3000";
  const deviceId = readArg("device-id") ?? "stack-001";
  const payload = {
    deviceId,
    state: "moving",
    timestamp: 123456,
    delta: 42,
    bootId: "seed-boot-001",
    firmwareVersion: "0.3.0",
    hardwareId: "seed-device-001",
  };

  const response = await fetch(`${apiUrl}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();

  console.log(
    JSON.stringify(
      {
        status: response.status,
        body,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to send test event.", error);
  process.exit(1);
});
