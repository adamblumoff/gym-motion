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
bun run dev:desktop
bun run dev:runtime
bun run dev:ble-sidecar
bun run dev:test-desktop
bun run test
bun run lint
bun run typecheck
bun run worktree:create:t3 -- <worktree-name> <branch-name>
```

The CLI dev flow now runs through a repo-local dev runner backed by Turbo task orchestration. It keeps the repo single-package, but gives worktrees and multiple local instances a more structured T3-style workflow.

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

## T3-Style Dev Flow

- `bun run dev` launches the default desktop developer experience through Turbo and the Gym Motion dev runner.
- `bun run dev:desktop` launches the Electron desktop stack directly through the same flow.
- `bun run dev:runtime` is a stable runtime-only extension point. In this phase it is an intentional no-op with clear logging because there is no standalone long-running runtime process yet.
- `bun run dev:ble-sidecar` builds the Windows BLE sidecar once and exits. A dedicated watch mode is deferred.
- `bun run dev:test-desktop` launches the desktop stack with `GYM_MOTION_E2E=1`.

The dev runner writes local state under `~/.gym-motion-dev`:

- `settings.json`
- `keybindings.json`
- `state.json`
- `logs/dev-runner.log`
- `logs/tasks/*.log`
- `attachments/`

Useful environment variables:

- `GYM_MOTION_DEV_HOME`
- `GYM_MOTION_DEV_INSTANCE`
- `GYM_MOTION_PORT_OFFSET`
- `GYM_MOTION_RENDERER_PORT`
- `GYM_MOTION_RUNTIME_PORT`
- `GYM_MOTION_DEV_URL`
- `GYM_MOTION_AUTO_BOOTSTRAP_FROM_CWD`
- `GYM_MOTION_NO_BROWSER`
- `GYM_MOTION_LOG_DEV_EVENTS`

Examples:

```bash
bun run dev -- --dry-run
GYM_MOTION_DEV_INSTANCE=bench-a bun run dev
GYM_MOTION_PORT_OFFSET=10 bun run dev:desktop
```

This is intentionally a CLI-first T3-style workflow. It does not include the full T3 dashboard UI in this phase.

## Notes

- The desktop product target is Windows only.
- The supported BLE runtime path is Windows app + Rust WinRT sidecar + ESP32 firmware app-session protocol.
- The desktop app reads env config from `.env` and `.env.local` before starting the local runtime pieces.
- Remote Postgres remains the v1 source of truth.
