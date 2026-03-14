# Testing From WSL

read_when: you are running the desktop app from Ubuntu/WSL, validating a Windows build, or adding smoke-test scripts.

## Default Flow

Use WSL as the command environment, but test the real packaged Windows app whenever you need desktop validation.

Fast iteration:

- `bun run dev` runs the Electron app directly in the current environment
- use mock BLE/runtime data for most UI and IPC work

Windows validation:

1. Build the Windows package on the Windows side or from a compatible packaging environment.
2. From WSL, run `bun run test:windows-desktop`.
3. The helper looks for a packaged `.exe` under `release/` and launches it through `powershell.exe`.

## Why

This keeps the edit/build loop comfortable in WSL while still making it easy to sanity-check the actual Windows desktop binary.

## Current Limitation

The repo does not yet automate a full packaged Windows build from WSL on ARM64. The helper script is for launch-and-smoke workflows once a Windows build exists.
