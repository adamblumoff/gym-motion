# Desktop Architecture

read_when: you are touching the new Electron app, changing IPC boundaries, or deciding where gateway logic should live.

## Shape

The desktop app is split into three layers:

- `desktop/main`: owns Electron lifecycle, tray behavior, and native process concerns
- `desktop/preload`: exposes a narrow typed API to the renderer
- `desktop/ui`: React app for the operator experience
- `desktop/core`: shared domain models and service contracts

## Boundary Rules

- The renderer should not call localhost HTTP routes.
- Live updates should cross the Electron boundary as typed events, not SSE.
- Native BLE access must stay behind one adapter interface so we can swap between Node and a future Rust sidecar.
- Shared Gym Motion types should live in `desktop/core`, not be duplicated between main and renderer.

## Migration Defaults

- Windows is the first-class target.
- Tray-running behavior is part of the product, not an optional dev mode.
- Remote Postgres remains the v1 system of record.
- The legacy Next.js app is archived under `legacy/` and should not receive feature work.
