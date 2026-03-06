const apiUrl = process.env.API_URL ?? "http://localhost:3000";

async function main() {
  const payload = {
    deviceId: "stack-001",
    state: "moving",
    timestamp: Date.now(),
    delta: 42,
  };

  const response = await fetch(`${apiUrl}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();

  console.log({
    status: response.status,
    body,
  });
}

main().catch((error) => {
  console.error("Failed to send test event.", error);
  process.exit(1);
});
