# Gym Motion

## Current Status

This repo has two active product tracks:

- `desktop/`: the Electron desktop cloud client
- `native/linux-dotnet-ble-gateway/`: the Linux BLE gateway that forwards telemetry to Railway

Firmware, backend, native code, scripts, and shared packages stay at the top level because they support the current cloud-backed flow.

Architecture is not documented as source-of-truth here. When changing behavior, inspect the current repo entrypoints directly:

- `desktop/main/index.ts`
- `desktop/main/runtime.ts`
- `desktop/main/cloud-runtime.ts`
- `backend/server/standalone.ts`
- `desktop/preload/index.ts`

Historical bug context lives in [docs/bugs/windows-ble-bugs.md](/home/adamblumoff/gym-motion/docs/bugs/windows-ble-bugs.md), but current code and tests win if they disagree.

## Runtime Stack

- Linux `.NET` BLE gateway for node connectivity and HTTP ingest
- Railway-hosted backend for persistence, analytics, and SSE updates
- Electron desktop app as a cloud client for dashboard and analytics
- Shared TypeScript core for contracts and runtime helpers

## Commands

```bash
bun install
bun run dev
bun run test
bun run lint
bun run typecheck
bun run backend:dev
bun run db:migrate
bun run worktree:create:t3 -- <worktree-name> <branch-name>
```

Linux gateway:

```bash
bun run gateway:linux
bun run gateway:linux:install
bun run gateway:linux:start
bun run gateway:linux:stop
bun run gateway:linux:status
bun run gateway:linux:logs
```

## Windows Validation

- Use a Windows clone at `C:\Users\adamb\Code\gym-motion` for real desktop validation.
- Copy `.env.local` into that Windows repo after cloning.
- Set `GYM_MOTION_CLOUD_API_BASE_URL` so the desktop can talk to Railway.
- Validate the real desktop flow against the live backend, not a local BLE gateway.
- Create new T3 worktrees through `bun run worktree:create:t3 -- <worktree-name> <branch-name>` so `.env.local` is provisioned automatically.
- The new worktree command shares `.env.local` live by default when links are available, so editing `.env.local` inside a linked worktree updates the shared source env file too.
- If Windows blocks linking, the command falls back to a copy and prints that the worktree is no longer live-synced.

## Notes

- The desktop app is now a cloud client, not a BLE gateway host.
- BLE ownership lives on Linux gateways with attached adapters.
- The desktop app reads env config from `.env` and `.env.local` before starting.
- Railway-backed Postgres is the canonical source of truth.
