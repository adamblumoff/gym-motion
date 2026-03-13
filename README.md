# Gym Motion

Gateway-first motion dashboard for BLE sensor nodes.

This version is intentionally cheap and simple:

- sensor nodes publish motion over BLE, not direct Wi-Fi HTTP
- a local Linux gateway receives BLE updates and serves the operator console on the same Wi-Fi network
- the frontend shows multiple devices at once
- device location is static metadata only, using labels like machine name and zone
- the current firmware is an ESP32 reference implementation for a future lower-power BLE-only node

## Stack

- Next.js App Router + TypeScript
- Railway PostgreSQL
- Bun for app/package management
- local Node BLE gateway using `@abandonware/noble`
- ESP32 reference node sketch in `gym_motion/gym_motion.ino`

## Required environment variables

Create `.env.local` with:

```bash
DATABASE_PUBLIC_URL=postgresql://USER:PASSWORD@HOST:PORT/railway
AWS_S3_BUCKET_NAME=your-private-firmware-bucket
AWS_ENDPOINT_URL=https://your-bucket-endpoint
AWS_DEFAULT_REGION=iad
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

The gateway uses `API_URL` when forwarding locally. It defaults to `http://localhost:3000`.
The gateway also exposes a local runtime API for the Next app on `GATEWAY_RUNTIME_PORT`, which defaults to `4010`.

## Local setup

```bash
bun install
bun run db:setup
bun dev
```

Open:

- dashboard: `http://localhost:3000`
- gateway control: `http://localhost:3000/connect`
- device logs: `http://localhost:3000/logs`

## POC architecture

### BLE Node

Each sensor node:

- reads motion from the ADXL345
- reduces state to `moving` or `still`
- keeps a stable `deviceId`
- advertises a BLE runtime service
- sends telemetry packets like:

```json
{
  "deviceId": "stack-001",
  "state": "moving",
  "delta": 42,
  "timestamp": 123456,
  "bootId": "esp32-a1-5f7c1a91",
  "firmwareVersion": "0.5.1",
  "hardwareId": "esp32-a1"
}
```

The current repo uses an ESP32 sketch as a reference node implementation. The product direction assumes lower-power BLE-only nodes that never join Wi-Fi directly.

### Gateway

The gateway:

- scans for the BLE runtime service
- subscribes to node telemetry
- forwards state changes to `POST /api/ingest`
- forwards repeated keepalive packets to `POST /api/heartbeat`
- serves the operator console on the same Wi-Fi network
- acts as the live source of truth for the local operator console

Run it with:

```bash
bun run gateway
```

Optional environment variables:

```bash
API_URL=http://localhost:3000
GATEWAY_VERBOSE=1
GATEWAY_HEARTBEAT_DEDUPE_MS=10000
GATEWAY_FIRMWARE_CHECK_MS=60000
GATEWAY_OTA_CHUNK_SIZE=128
```

Linux notes:

- this gateway is meant for Linux because the future product target is Linux
- if you run from WSL, BLE access may require extra host passthrough setup
- native Linux is the safest path for bench testing

### Frontend

The operator console:

- automatically follows the same Linux gateway host that served the page
- reads live BLE connection state from the gateway runtime, not stale backend timestamps
- subscribes to gateway runtime updates and forwarded motion events over the local network
- does not require browser Bluetooth support for the normal monitoring flow
- does not require a separate "find your gateway" step in the normal same-host flow

### Backend

The backend contract remains intentionally small:

- `POST /api/ingest` stores forwarded motion events
- `POST /api/heartbeat` keeps quiet devices marked alive
- `GET /api/devices` returns the multi-device board
- `POST /api/devices` and `PATCH /api/devices/:deviceId` manage static metadata
- existing firmware release/check/report routes remain available for the current reference firmware flow

The current schema already supports multiple devices. This POC reuses:

- `machine_label` as the display name
- `site_id` as a simple zone/location label

## Running the whole POC

1. Start the app:

```bash
bun dev
```

2. Flash the reference node firmware:

```bash
bun run firmware:upload -- --port <serial-port>
```

3. Start the app on the gateway host:

```bash
bun dev
```

4. Open the app from another device on the same Wi-Fi using the gateway hostname, for example `http://gateway-host.local:3000`.

5. Start the BLE gateway:

```bash
bun run gateway
```

6. Move a node. The dashboard should show the device as `MOVING` or `STILL`.

The frontend now treats the gateway as the source of truth for node connectivity:

- if the gateway sees a node and connects, the device card updates immediately
- if the gateway restarts or loses the BLE link, the frontend shows that runtime state directly
- the node no longer appears "online" just because the database has an old heartbeat

## Reference Firmware Flow

The repo still includes a working ESP32 reference firmware path for bench testing:

- `bun run reference-node:build`
- `bun run reference-node:upload -- --port <serial-port>`
- `bun run reference-node:publish -- --version <version>`

This should be treated as the current reference-node workflow rather than the permanent product firmware contract.

## Database setup

Apply the schema reset:

```bash
bun run db:setup
```

Or:

```bash
psql "$DATABASE_PUBLIC_URL" -f sql/001_init.sql
```

This is still an MVP-style destructive schema reset.
