# Desktop Architecture

read_when: you are touching the new Electron app, changing IPC boundaries, or deciding where gateway logic should live.

## Shape

The desktop app is split into three layers:

- `desktop/main`: owns Electron lifecycle, tray behavior, and native process concerns
- `desktop/preload`: exposes a narrow typed API to the renderer
- `desktop/ui`: React app for the operator experience
- `desktop/core`: shared domain models and service contracts
- `backend/`: active gateway/runtime and data-access code shared by the desktop pipeline

The current product target is Windows only. The runtime BLE contract should be treated as Windows app plus WinRT sidecar plus ESP32 firmware session handling, not as a cross-platform desktop abstraction.

## Boundary Rules

- The renderer should not call localhost HTTP routes.
- Live updates should cross the Electron boundary as typed events, not SSE.
- Native BLE access should be treated as a Windows WinRT sidecar boundary first. Non-Windows BLE paths still in the repo are for bench and development use only and should not drive product behavior by default.
- The Windows sidecar currently depends on a vendored, patched `btleplug` under [native/windows-ble-sidecar/vendor/btleplug-winrt-patched](/home/adamblumoff/gym-motion/native/windows-ble-sidecar/vendor/btleplug-winrt-patched). That patch is part of the supported Windows BLE transport contract right now, not an incidental local tweak.
- Approved-node identity policy should have one TS source of truth under `desktop/core`. Do not re-implement `knownDeviceId -> peripheralId -> address -> unique localName` matching separately in setup UI, main-process setup reconciliation, or other desktop helpers.
- Reconnect handshakes need exclusive adapter attention. On Windows, pause active BLE scanning before attempting reconnect GATT setup; otherwise WinRT can surface a half-connected state where the ESP32 sees a client but `connect()`/`discover_services()` still fail and the session never reaches bootstrap or lease.
- Shared Gym Motion types should live in `desktop/core`, not be duplicated between main and renderer.
- Transport connection state and telemetry freshness are separate signals. Motion or heartbeat telemetry must not change BLE connection state on their own.
- State ownership rule:
  sidecar owns BLE scan/reconnect/handshake truth,
  firmware owns app-session lease/watchdog truth,
  runtime server owns projection/cache only,
  Electron main owns persistence and app lifecycle,
  renderer owns presentation only.

## Migration Defaults

- Windows is the only active desktop product target right now.
- Tray-running behavior is part of the product, not an optional dev mode.
- Remote Postgres remains the v1 system of record.
- Active desktop runtime and data-access code belongs under `desktop/` and `backend/`.
- `desktop/` and `backend/` must not reintroduce removed archive import paths. The repo enforces this with `scripts/check-no-archive-imports.mjs`.
