# Gym Motion

Motion dashboard and device control plane for ESP32-based gym stack sensors.

The web app now does four jobs:

- shows live `MOVING` / `STILL` state over SSE
- tracks device health with server-side `ONLINE` / `STALE` / `OFFLINE`
- gives you a `/setup` screen for assigning machine labels, adding devices, and provisioning fresh hardware over BLE
- manages OTA firmware releases and device update status
- exposes a separate `/logs` view for per-device remote logs

The incoming `timestamp` is still the ESP32 `millis()` value. Human-readable recency comes from server receipt time, not device time.
The BLE setup flow is v1 and optimized for Chrome or Edge over HTTPS.

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
AWS_S3_BUCKET_NAME=your-private-firmware-bucket
AWS_ENDPOINT_URL=https://your-bucket-endpoint
AWS_DEFAULT_REGION=iad
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

Railway should provide `DATABASE_PUBLIC_URL` to the web service in production.
Railway Buckets also provide the `AWS_*` variables to the web service.

## Local setup

```bash
bun install
bun run db:setup
bun dev
```

Open:

- live dashboard: `http://localhost:3000`
- setup screen: `http://localhost:3000/setup`
- device logs: `http://localhost:3000/logs`

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
drop table if exists device_logs;
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
  md5 text,
  size_bytes bigint not null,
  rollout_state text not null default 'draft',
  created_at timestamp not null default now()
);

create table if not exists device_logs (
  id bigserial primary key,
  device_id text not null,
  level text not null,
  code text not null,
  message text not null,
  boot_id text,
  firmware_version text,
  hardware_id text,
  device_timestamp bigint,
  metadata jsonb,
  received_at timestamp not null default now()
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
  "firmwareVersion": "0.4.2",
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
  "firmwareVersion": "0.4.2",
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

### `POST /api/devices`

Creates or updates a placeholder device row before BLE provisioning finishes:

```json
{
  "deviceId": "stack-001",
  "machineLabel": "Leg Press 2",
  "siteId": "gym-dallas",
  "hardwareId": "esp32-a1",
  "provisioningState": "assigned"
}
```

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

### `GET /api/device-logs`

Returns remote logs, optionally filtered by device:

```text
/api/device-logs?deviceId=stack-001&limit=100
```

### `POST /api/device-logs`

Structured device log from the ESP32:

```json
{
  "deviceId": "stack-001",
  "level": "warn",
  "code": "ota.failed",
  "message": "OTA update failed.",
  "bootId": "esp32-a1-5f7c1a91",
  "firmwareVersion": "0.4.2",
  "hardwareId": "esp32-a1",
  "timestamp": 45678,
  "metadata": {
    "reason": "http-begin-failed"
  }
}
```

### `GET /api/stream`

SSE stream used by the live dashboard, setup screen, and `/logs`.

### `GET /api/firmware/check`

Checks whether a device should update:

```text
/api/firmware/check?deviceId=stack-001&firmwareVersion=0.4.2
```

### `GET /api/firmware/releases`

Returns stored firmware release metadata.

### `POST /api/firmware/releases`

Stores a firmware release row:

```json
{
  "version": "0.3.1",
  "gitSha": "abc1234",
  "assetUrl": "firmware/0.4.2/gym_motion.ino.bin",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "md5": "0123456789abcdef0123456789abcdef",
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

The repo ships its own `arduino-cli` binary in `bin/arduino-cli`, so `bun run firmware:build` uses the repo toolchain instead of relying on your shell `PATH`.

One-time local setup for a fresh machine:

```bash
./bin/arduino-cli core install esp32:esp32
```

Default board target and partition scheme:

```text
FQBN=esp32:esp32:esp32
PARTITIONS=min_spiffs
```

Override it if needed:

```bash
FQBN=esp32:esp32:esp32 PARTITIONS=min_spiffs bun run firmware:build
```

Recommended manual QA flow before publishing a firmware tag:

```bash
bun test
bun run lint
bun run build
bun run firmware:build
```

There is also a GitHub Actions workflow at `.github/workflows/firmware-release.yml` that can fully publish firmware on tag pushes like `firmware-v0.4.2`.

For full automation, add these GitHub repository secrets:

- `API_URL`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_ENDPOINT_URL`
- `AWS_DEFAULT_REGION`
- `AWS_S3_BUCKET_NAME`

Then this flow is fully automatic:

```bash
git tag firmware-v0.4.2
git push origin firmware-v0.4.2
```

The workflow will:

- build the firmware binary
- generate checksums
- upload the workflow artifact
- publish the binary to the private Railway bucket
- register the firmware release in the API

You can still publish a built firmware binary manually if needed:

```bash
railway run bun run firmware:publish -- --version 0.4.1 --rollout active
```

The publish script uploads `build/firmware/gym_motion.ino.bin` to the private Railway bucket and stores the object key in the database. The OTA check endpoint then turns that object key into a short-lived presigned download URL for devices.

## OTA firmware flow

1. Flash the ESP32 once over USB with the OTA-capable sketch and `min_spiffs` partition scheme.
2. The device sends normal motion events plus heartbeats with `firmwareVersion`, `bootId`, and `hardwareId`.
3. A background OTA task on the device checks `/api/firmware/check` every few minutes while the device is idle.
4. If the backend advertises a newer active release, the device downloads the `.bin` from a short-lived presigned Railway bucket URL over HTTPS.
5. The device verifies the image checksum, writes it to the inactive OTA app slot, reports `applied`, and restarts.
6. On the next boot, the device reports `booted` and continues normal motion tracking.
7. The device also posts structured lifecycle logs to `/api/device-logs`, and the `/logs` page streams them live by device.

The release workflow still generates `.sha256` and `.md5` files alongside the firmware binary. The bucket stays private; devices only see temporary presigned URLs.

## BLE provisioning flow

1. If the app sees zero devices in the database, it shows the setup wizard instead of the live board.
2. The installer uses Chrome or Edge, clicks once, and picks the unprovisioned device from the Bluetooth chooser.
3. The device scans nearby Wi-Fi networks over BLE and sends the SSID list back to the browser.
4. The installer picks the gym network, optionally reuses the locally remembered Wi-Fi profile, and assigns `deviceId` / `siteId`.
5. The browser creates a placeholder device row with `provisioningState = "assigned"`.
6. The browser sends Wi-Fi credentials and identity to the ESP32 over BLE.
7. The ESP32 stores the config in NVS, joins Wi-Fi, reboots into normal mode, and appears online as `provisioned`.

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

Purge one device's historical rows before an OTA test:

```bash
DEVICE_ID=stack-001 bun run device:purge
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
8. The logs screen shows OTA, Wi-Fi, heartbeat, and motion lifecycle logs per device.
