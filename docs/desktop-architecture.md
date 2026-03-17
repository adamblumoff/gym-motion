# Desktop Architecture

read_when: you are touching the new Electron app, changing IPC boundaries, or deciding where gateway logic should live.

## Shape

The desktop app is split into three layers:

- `desktop/main`: owns Electron lifecycle, persistence, and operator intents that drive the gateway runtime
- `desktop/preload`: exposes the typed intent API (pair, forget, reconnect) and projection events to the renderer
- `desktop/ui`: React app for the operator experience
- `shared/`: the neutral TypeScript surface for contracts, approved-node matching, gateway scan helpers, and desktop services imported by both main and renderer
- `backend/`: runtime server, data-access code, and projection helpers for caching sidecar events

The current product target is Windows only. The runtime BLE contract should be treated as Windows app plus WinRT sidecar plus ESP32 firmware session handling, not as a cross-platform desktop abstraction.

## Boundary Rules

- The renderer should not call localhost HTTP routes; it talks to the gateway runtime via the preload intent API and typed events.
- Native BLE access is owned by the Windows WinRT sidecar. The desktop product runtime no longer includes the older noble/HCI/USB BLE path.
- The sidecar depends on the patched `btleplug` under [native/windows-ble-sidecar/vendor/btleplug-winrt-patched](/home/adamblumoff/gym-motion/native/windows-ble-sidecar/vendor/btleplug-winrt-patched) as part of the supported Windows transport contract.
- Approved-node identity matching now lives under `shared/approved-node-runtime-match.ts`; that single resolver order (`knownDeviceId -> peripheralId -> address -> unique localName`) is the canonical source for both renderer selectors and main-process reconcilers.
- Reconnect handshakes keep their own adapter attention. Windows pauses approval scans before reconnect so WinRT never reports a half-connected state that blocks bootstrap/lease.
- Shared Gym Motion types now live in `shared/contracts.*`; do not duplicate them between main and renderer anymore.
- Transport connection state and telemetry freshness are separate signals; telemetry payloads must not flip the BLE connection status alone.
- Ownership rule:
-  sidecar owns BLE scan/reconnect/handshake truth,
-  firmware owns app-session lease/watchdog truth,
-  runtime server owns projection/cache only,
-  Electron main owns persistence, lifecycle, and intent sequencing,
-  renderer owns presentation only.

## Intent & Runtime Ownership

- `desktop/main` sequences the operator intents (pair discovered node, forget node, resume reconnect) and owns persistence/lifecycle so the renderer never writes those flows directly.
- `desktop/preload` exposes those high-level intents plus `setThemePreference` and emits projection events derived from the runtime cache; the renderer consumes those events to update the UI without inventing its own transport logic.
- `backend/runtime` remains the projection/cache owner: it translates sidecar events into device snapshots, known-node persistence, and HTTP APIs that only represent cached state, not raw BLE truth.
- The sidecar is the sole owner of BLE transport truth, including scan/reconnect handshakes and handshake diagnostics; runtime/main ask it for actions, and the renderer only reacts to what the runtime reports.
## Migration Defaults

- Windows is the only active desktop product target right now.
- Tray-running behavior is part of the product, not an optional dev mode.
- Remote Postgres remains the v1 system of record.
- Active desktop runtime and data-access code belongs under `desktop/` and `backend/`.
- `desktop/` and `backend/` must not reintroduce removed archive import paths. The repo enforces this with `scripts/check-no-archive-imports.mjs`.
