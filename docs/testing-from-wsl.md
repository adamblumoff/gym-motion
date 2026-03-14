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
4. On Windows, run `bun install` and `bun run dev`.
5. Use the `Setup` tab to validate adapter selection and approved-node reconnect behavior.
6. Build the Windows package on the Windows side with `bun run build:win`.
7. From WSL, run `bun run test:windows-desktop` if you want a helper to launch an already-built `.exe`.

## Why

This keeps the edit/build loop comfortable in WSL while still making it easy to sanity-check the actual Windows desktop binary.

## Current Limitation

The repo does not yet automate a full packaged Windows build from WSL on ARM64. The helper script is for launch-and-smoke workflows once a Windows build exists.
