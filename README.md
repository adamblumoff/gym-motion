# Gym Motion

Motion dashboard and device control plane for ESP32-based gym stack sensors.

The web app now does four jobs:

- shows live `MOVING` / `STILL` state over SSE
- tracks device health with server-side `ONLINE` / `STALE` / `OFFLINE`
- gives you a simple `/setup` screen for assigning machine labels and sites
- stores firmware release metadata so the repo can grow into OTA safely

The incoming `timestamp` is still the ESP32 `millis()` value. Human-readable recency comes from server receipt time, not device time.

## Stack

- Next.js App Router + TypeScript
- Railway PostgreSQL
- Bun
- Direct SQL with `pg`
- ESP32 Arduino sketch in `gym_motion/gym_motion.ino`

## Required environment variables

Create `.env.local` with:

```bash
DATABASE_PUBLIC_URL=postgresql://USER:PASSWORD@HOST:PORT/railway
```

Railway should provide `DATABASE_PUBLIC_URL` to the web service in production.

## Local setup

```bash
bun install
bun run db:setup
bun dev
```

Open:

- live dashboard: `http://localhost:3000`
- setup screen: `http://localhost:3000/setup`

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

## SQL schema

```sql
drop table if exists motion_events;
drop table if exists firmware_releases;
drop table if exists devices;

create table if not exists devices (
  id text primary key,
  last_state text not null default 'still',
  last_seen_at bigint not null default 0,
  last_delta integer,
  updated_at timestamp not null default now(),
  hardware_id text,
  boot_id text,
  firmware_version text not null default 'unknown',
  machine_label text,
  site_id text,
  provisioning_state text not null default 'unassigned',
  update_status text not null default 'idle',
  last_event_received_at timestamp,
  last_heartbeat_at timestamp,
  wifi_provisioned_at timestamp
);

create table if not exists motion_events (
  id bigserial primary key,
  device_id text not null references devices (id) on delete cascade,
  state text not null,
  delta integer,
  event_timestamp bigint not null,
  received_at timestamp not null default now(),
  boot_id text,
  firmware_version text,
  hardware_id text
);

create table if not exists firmware_releases (
  version text primary key,
  git_sha text not null,
  asset_url text not null,
  sha256 text not null,
  size_bytes bigint not null,
  rollout_state text not null default 'draft',
  created_at timestamp not null default now()
);
```

## API

### `POST /api/ingest`

Motion state change from the ESP32:

```json
{
  "deviceId": "stack-001",
  "state": "moving",
  "timestamp": 123456,
  "delta": 42,
  "bootId": "esp32-a1-5f7c1a91",
  "firmwareVersion": "0.3.0",
  "hardwareId": "esp32-a1"
}
```

### `POST /api/heartbeat`

Periodic liveness ping from the device:

```json
{
  "deviceId": "stack-001",
  "timestamp": 123999,
  "bootId": "esp32-a1-5f7c1a91",
  "firmwareVersion": "0.3.0",
  "hardwareId": "esp32-a1"
}
```

### `GET /api/devices`

Returns live device summaries including:

- health status
- machine label
- site ID
- firmware version
- boot ID
- last heartbeat and event receipt times

### `PATCH /api/devices/:deviceId`

Updates setup metadata:

```json
{
  "machineLabel": "Leg Press 2",
  "siteId": "gym-dallas",
  "hardwareId": "esp32-a1",
  "provisioningState": "assigned"
}
```

### `GET /api/events`

Returns recent motion events from the database.

### `GET /api/stream`

SSE stream used by the live dashboard and setup screen.

### `GET /api/firmware/check`

Checks whether a device should update:

```text
/api/firmware/check?deviceId=stack-001&firmwareVersion=0.3.0
```

### `GET /api/firmware/releases`

Returns stored firmware release metadata.

### `POST /api/firmware/releases`

Stores a firmware release row:

```json
{
  "version": "0.3.1",
  "gitSha": "abc1234",
  "assetUrl": "https://github.com/owner/repo/releases/download/firmware-v0.3.1/gym_motion.bin",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "sizeBytes": 245760,
  "rolloutState": "active"
}
```

### `POST /api/firmware/report`

Device OTA status report:

```json
{
  "deviceId": "stack-001",
  "status": "booted",
  "targetVersion": "0.3.1"
}
```

## Firmware workflow

Repo source of truth:

- sketch: `gym_motion/gym_motion.ino`
- Windows Arduino IDE mirror: `C:\Users\adamb\OneDrive\Desktop\gym_esp32_wifi_v1\gym_esp32_wifi_v1.ino`

When the sketch changes, copy the repo version over to the Windows Arduino file before flashing.

Build locally with Arduino CLI:

```bash
bun run firmware:build
```

Default board target:

```text
esp32:esp32:esp32
```

Override it if needed:

```bash
FQBN=esp32:esp32:esp32 bun run firmware:build
```

There is also a GitHub Actions workflow at `.github/workflows/firmware-release.yml` that builds firmware on tag pushes like `firmware-v0.3.1` and uploads the binary as a release asset.

## Test / seed

Send a sample event:

```bash
bun run seed
```

Run tests:

```bash
bun test
bun run lint
bun run build
```

## Railway deployment

1. Create a Railway project.
2. Add a PostgreSQL service.
3. Add this repo as a web service.
4. Set `DATABASE_PUBLIC_URL` on the web service.
5. Run the schema once with `bun run db:setup` or `psql`.
6. Deploy.

## ESP32 -> API -> DB -> UI flow

1. The ESP32 sends `POST /api/ingest` on state changes.
2. The ESP32 sends `POST /api/heartbeat` on a fixed interval.
3. The backend writes motion events to `motion_events`.
4. The backend upserts current device status and metadata in `devices`.
5. The backend broadcasts live changes over `/api/stream`.
6. The live board shows motion state instantly.
7. The setup screen shows health, identity, and firmware metadata for installation work.
