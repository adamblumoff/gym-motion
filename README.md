# Gym Motion Desktop

Windows-only Electron app for the current Gym Motion gateway and operator console.

## Current Status

This repo has one active desktop product track:

- `desktop/`: the active Electron desktop app

Firmware, native code, scripts, and shared packages stay at the top level because they support the current Windows desktop workflow.

Architecture is not documented as source-of-truth here. When changing behavior, inspect the current repo entrypoints directly:

- `desktop/main/index.ts`
- `desktop/main/runtime.ts`
- `desktop/main/managed-gateway-runtime.ts`
- `desktop/preload/index.ts`

Historical bug context lives in [docs/bugs/windows-ble-bugs.md](/home/adamblumoff/gym-motion/docs/bugs/windows-ble-bugs.md), but current code and tests win if they disagree.

## Desktop Stack

- Electron main process for lifecycle, tray, persistence, and native integration
- React renderer app for operator workflows
- Shared TypeScript core for contracts and runtime helpers
- Rust WinRT BLE sidecar on Windows for built-in Bluetooth support
- Windows-first packaging via `electron-builder`

## Commands

```bash
bun install
bun run dev
bun run test
bun run lint
bun run typecheck
bun run worktree:create:t3 -- <worktree-name> <branch-name>
```

Windows packaging:

```bash
bun run build:win
```

WSL launch helper for a built Windows `.exe`:

```bash
bun run test:windows-desktop
```

## Windows Validation

- Use a Windows clone at `C:\Users\adamb\Code\gym-motion` for real desktop validation.
- Copy `.env.local` into that Windows repo after cloning.
- Install the Rust MSVC toolchain on Windows before running `bun run dev` or `bun run build:win`.
- Validate the real BLE flow from Windows, not from a non-Windows bench path.
- Create new T3 worktrees through `bun run worktree:create:t3 -- <worktree-name> <branch-name>` so `.env.local` is provisioned automatically.
- The new worktree command shares `.env.local` live by default when links are available, so editing `.env.local` inside a linked worktree updates the shared source env file too.
- If Windows blocks linking, the command falls back to a copy and prints that the worktree is no longer live-synced.

## Notes

- The desktop product target is Windows only.
- The supported BLE runtime path is Windows app + Rust WinRT sidecar + ESP32 firmware app-session protocol.
- The desktop app reads env config from `.env` and `.env.local` before starting the local runtime pieces.
- Remote Postgres remains the v1 source of truth.
