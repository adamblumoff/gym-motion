# Gym Motion Desktop

Windows-only Electron app for the current Gym Motion gateway and operator console.

## Current Status

This repo now has one active product track:

- `desktop/`: the active Electron desktop app

Firmware, bench scripts, and repo docs stay at the top level because they support the current desktop and hardware workflow.

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
- `shared`: shared contracts, identity rules, and runtime abstractions

## Notes

- The desktop app now boots the real embedded gateway runtime. It reads env config from `.env` and `.env.local` before starting the local API bridge and BLE transport.
- The current desktop product target is Windows only. BLE runtime behavior should be designed around the Windows app, the WinRT sidecar, and the ESP32 app-session protocol.
- On Windows, Bluetooth binds automatically to the native adapter. The `Setup` tab is node-only, and Bluetooth discovery stays manual for first-time discovery and pairing.
- On Windows, approved nodes now reconnect automatically in the background after app restarts or BLE link loss; operators should only need manual scan for discovery and setup work.
- On Windows, disconnected approved nodes now stay in a silent reconnect search until the sidecar rediscovers them and starts a real reconnect attempt. After 20 failed reconnect attempts for one paired node, the homepage sensor card shows a local forget-device prompt for that node.
- On Windows, when a managed node reconnects, the gateway sends an explicit runtime `sync-now` control command so the node immediately republishes its current telemetry snapshot after gateway restarts or link recovery.
- Firmware now also expects a Windows app-session lease over BLE. The sidecar renews that lease every 5 seconds, and the node expires it after 15 seconds so it can drop stale Windows sessions, restart advertising, and become reconnectable again if the app disappears without a clean BLE disconnect.
- On Windows, the desktop app uses the native Rust WinRT BLE sidecar so it can see built-in Bluetooth adapters. Non-Windows BLE runtime code that remains in `backend/` is bench/dev support only and is not the active product runtime.
- Real BLE validation should happen from a Windows-side clone at `C:\Users\adamb\Code\gym-motion`, with `.env.local` copied into that repo after cloning.
- Windows-side local development now requires the Rust MSVC toolchain because `bun run dev` and `bun run build:win` build the native BLE sidecar before launching or packaging.
- The plan still assumes remote Postgres remains the source of truth for v1.
- Auto-updates are deferred on purpose, but the packaging path is set up so we can add them later.
