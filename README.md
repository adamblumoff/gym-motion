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
- Rust WinRT BLE sidecar on Windows for built-in Bluetooth support
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

Windows-side testing guide:

- [docs/testing-on-windows.md](/home/adamblumoff/gym-motion/docs/testing-on-windows.md)

## Repo Layout

- `desktop/main`: Electron main process and runtime wiring
- `desktop/preload`: typed preload bridge
- `desktop/ui`: renderer app
- `desktop/core`: shared contracts, helpers, and runtime abstractions
- `legacy`: archived web-plus-gateway implementation

## Notes

- The desktop app now boots the real embedded gateway runtime. It reads env config from `.env` and `.env.local` before starting the local API bridge and BLE transport.
- On Windows, Bluetooth binds automatically to the native adapter. The `Setup` tab is node-only, and Bluetooth discovery is manual: scan when you want to connect or reconnect nodes.
- On Windows, once a managed node reconnects, the gateway now sends an explicit runtime `sync-now` control command so the node immediately republishes its current telemetry snapshot after gateway restarts.
- On Windows, the desktop app uses the native Rust WinRT BLE sidecar so it can see built-in Bluetooth adapters. The legacy noble gateway stays in place for non-Windows hosts.
- Real BLE validation should happen from a Windows-side clone at `C:\Users\adamb\Code\gym-motion`, with `.env.local` copied into that repo after cloning.
- Windows-side local development now requires the Rust MSVC toolchain because `bun run dev` and `bun run build:win` build the native BLE sidecar before launching or packaging.
- The plan still assumes remote Postgres remains the source of truth for v1.
- Auto-updates are deferred on purpose, but the packaging path is set up so we can add them later.
