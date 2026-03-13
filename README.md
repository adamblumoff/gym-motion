# Gym Motion

BLE-first motion dashboard and proof-of-concept gateway for ESP32-based gym sensors.

This version is intentionally cheap and simple:

- sensor nodes publish motion over BLE, not direct Wi-Fi HTTP
- a local Linux gateway receives BLE updates and forwards them to the existing backend
- the frontend shows multiple devices at once
- device location is static metadata only, using labels like machine name and zone
- OTA is now gateway-driven: the gateway downloads firmware once and pushes it to nearby BLE nodes

## Stack

- Next.js App Router + TypeScript
- Railway PostgreSQL
- Bun for app/package management
- local Node BLE gateway using `@abandonware/noble`
- ESP32 Arduino sketch in `gym_motion/gym_motion.ino`

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

## Local setup

```bash
bun install
bun run db:setup
bun dev
```

Open:

- dashboard: `http://localhost:3000`
- setup screen: `http://localhost:3000/setup`
- device logs: `http://localhost:3000/logs`

## POC architecture

### Node

Each ESP32 node:

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
  "firmwareVersion": "0.5.0",
  "hardwareId": "esp32-a1"
}
```

The sketch also keeps a BLE provisioning service for saving `deviceId`, machine label, and zone metadata.

### Gateway

The gateway:

- scans for the BLE runtime service
- subscribes to node telemetry
- forwards state changes to `POST /api/ingest`
- forwards repeated keepalive packets to `POST /api/heartbeat`
- checks the backend for active firmware releases
- downloads firmware once and pushes OTA chunks over BLE to each node

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

### Backend

The backend contract stays intentionally small:

- `POST /api/ingest` stores forwarded motion events
- `POST /api/heartbeat` keeps quiet devices marked alive
- `GET /api/devices` returns the multi-device board
- `POST /api/devices` and `PATCH /api/devices/:deviceId` manage static metadata
- existing firmware release/check/report routes are reused by the gateway OTA flow

The current schema already supports multiple devices. This POC reuses:

- `machine_label` as the display name
- `site_id` as a simple zone/location label

## Running the whole POC

1. Start the app:

```bash
bun dev
```

2. Flash the firmware:

```bash
bun run firmware:upload -- --port <serial-port>
```

3. If needed, open `/setup` and pair a node over Web Bluetooth to save its `deviceId` and zone.

4. Start the BLE gateway:

```bash
bun run gateway
```

5. Move a node. The dashboard should show the device as `MOVING` or `STILL`.

## Firmware OTA flow

For this POC, OTA works like this:

1. publish a firmware release to the existing backend
2. the gateway checks `/api/firmware/check` for each discovered device
3. the gateway downloads the firmware asset over HTTP
4. the gateway streams firmware chunks to the node over BLE
5. the node applies the update and reboots
6. the gateway reports update status back through `/api/firmware/report`

Nodes no longer download firmware directly over Wi-Fi.

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
