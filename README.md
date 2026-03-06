# Gym Motion MVP

Minimal motion dashboard for an ESP32 device.

The device sends `POST /api/ingest` whenever its motion state changes. The app stores every event in PostgreSQL, keeps the latest state per device, and the dashboard polls the backend to show whether each device is currently `MOVING` or `STILL` while also listing recent events from the database.

The incoming `timestamp` is the ESP32 `millis()` value, not a wall-clock Unix timestamp. The UI shows server receipt time as the human-readable "last seen" value and exposes the raw device millis for debugging.

## Stack

- Next.js App Router + TypeScript
- Railway PostgreSQL
- Bun
- Direct SQL with `pg`

## Required environment variables

Create `.env.local` with:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/railway
```

Railway will also provide `DATABASE_URL` in production.
You can copy `.env.example` as a starting point.

## Local setup

```bash
bun install
bun run db:setup
bun dev
```

Open `http://localhost:3000`.

## Database setup

Schema file:

- `sql/001_init.sql`

Apply it locally or against Railway with either of these:

```bash
bun run db:setup
```

Or with `psql`:

```bash
psql "$DATABASE_URL" -f sql/001_init.sql
```

This schema reset drops and recreates both tables for the MVP.

## SQL to create the tables

```sql
drop table if exists motion_events;
drop table if exists devices;

create table if not exists devices (
  id text primary key,
  last_state text not null,
  last_seen_at bigint not null,
  last_delta integer,
  updated_at timestamp not null default now()
);

create table if not exists motion_events (
  id bigserial primary key,
  device_id text not null,
  state text not null,
  delta integer,
  event_timestamp bigint not null,
  received_at timestamp not null default now()
);

create index if not exists motion_events_device_id_idx
  on motion_events (device_id, event_timestamp desc);
```

## API

### `POST /api/ingest`

Request body:

```json
{
  "deviceId": "stack-001",
  "state": "moving",
  "timestamp": 123456,
  "delta": 42
}
```

`timestamp` is the device uptime in milliseconds from `millis()`.

Success response:

```json
{
  "ok": true
}
```

### `GET /api/devices`

Returns the latest known state for all devices, including raw device millis and server `updatedAt`.

### `GET /api/events`

Returns a small recent-events feed from `motion_events` for dashboard visibility, including raw device millis and server `receivedAt`.

## Test / seed

Send a sample event to a running app:

```bash
bun run seed
```

Point it at another host if needed:

```bash
API_URL=https://your-app.up.railway.app bun run seed
```

Run tests:

```bash
bun test
```

## Railway deployment

1. Create a new Railway project.
2. Add a PostgreSQL service.
3. Add this repo as a web service.
4. Set `DATABASE_URL` on the web service using the Postgres connection string.
5. Run the schema once:
   - Railway Postgres console or `psql`
   - or connect locally and run `bun run db:setup`
6. Deploy.

Railway should detect the Next.js app automatically. If you want explicit commands, use:

```bash
Install: bun install
Build: bun run build
Start: bun run start
```

## ESP32 -> API -> DB -> UI flow

1. The ESP32 detects a state change and sends JSON to `POST /api/ingest`.
2. The backend validates the payload with Zod.
3. The backend inserts the raw event into `motion_events`.
4. The backend upserts the current device state into `devices`.
5. The dashboard polls `GET /api/devices` every 3 seconds.
6. The UI renders the latest state as `MOVING` or `STILL`, shows server-side "last seen" time, and shows raw device millis underneath for debugging.
