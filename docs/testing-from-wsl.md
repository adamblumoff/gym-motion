# Testing From WSL

read_when: you are running the desktop app from Ubuntu/WSL, validating a Windows build, or adding smoke-test scripts.

## Default Flow

Use WSL as the command environment, but test the real packaged Windows app whenever you need desktop validation.

Fast iteration:

- `bun run dev` runs the Electron app directly in the current environment
- use WSL for editing and quick desktop iteration when helpful

Windows validation:

1. Commit and push the repo state you want to test.
2. On Windows, clone the repo into `C:\Users\adamb\Code\gym-motion`.
3. Copy `.env.local` into that Windows repo.
4. On Windows, install the Rust MSVC toolchain if it is not already present.
5. On Windows, run `bun install` and `bun run dev`.
6. Use the `Setup` tab to run a manual scan when you need to discover or pair a node for the first time.
7. Build the Windows package on the Windows side with `bun run build:win`.
8. From WSL, run `bun run test:windows-desktop` if you want a helper to launch an already-built `.exe`.

## Why

This keeps the edit/build loop comfortable in WSL while still making it easy to sanity-check the actual Windows desktop binary.

The Windows-side repo now builds a Rust WinRT BLE sidecar before `bun run dev` and `bun run build:win`, so Windows is the source of truth for native BLE validation.

Managed nodes on Windows should now reconnect automatically in the background after app restarts or BLE link loss. The desktop app also sends silent reconnect nudges every 10 seconds while an approved node stays disconnected. For the current test pass, the forget-device prompt appears after 20 seconds per disconnected device before we raise it back to 10 minutes. After BLE reconnect, the gateway sends a runtime `sync-now` control command so the node republishes its current telemetry without waiting for a new motion event. Firmware also now expects a Windows app-session lease every 5 seconds and should drop a stale BLE session after 15 seconds without that lease so app restarts can recover cleanly.

## Current Limitation

The repo does not yet automate a full packaged Windows build from WSL on ARM64. The helper script is for launch-and-smoke workflows once a Windows build exists.
