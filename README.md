# Gym Motion Desktop

Windows-first Electron app for the Gym Motion gateway and operator console.

## Current Status

This repo now has two product tracks:

- `desktop/`: the active Electron desktop app
- `legacy/`: the archived Next.js plus gateway prototype that used to live at the repo root

Firmware, bench scripts, and repo docs stay at the top level because they still support the hardware workflow during the desktop migration.

## Desktop Stack

- Electron main process for tray, lifecycle, and native integration
- React renderer app for operator workflows
- shared TypeScript core for domain models and service contracts
- Windows-first packaging via `electron-builder`

## Commands

```bash
bun install
bun run dev
bun run test
bun run lint
bun run typecheck
```

Windows packaging:

```bash
bun run build:win
```

WSL launch helper for a built Windows `.exe`:

```bash
bun run test:windows-desktop
```

## Repo Layout

- `desktop/main`: Electron main process and runtime wiring
- `desktop/preload`: typed preload bridge
- `desktop/ui`: renderer app
- `desktop/core`: shared contracts, helpers, and runtime abstractions
- `legacy`: archived web-plus-gateway implementation

## Notes

- The current desktop runtime is mock-backed so we can iterate on the shell, IPC, and WSL workflow before the real BLE/data adapters land.
- The plan still assumes remote Postgres remains the source of truth for v1.
- Auto-updates are deferred on purpose, but the packaging path is set up so we can add them later.
