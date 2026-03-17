# Desktop Code Map

read_when: you need to find where desktop runtime behavior lives before changing logic, tests, or docs.

This map is the quick "where do I edit" index for the supported Windows desktop runtime path.

## Entry Points

- Electron app boot: [desktop/main/index.ts](/home/adamblumoff/gym-motion/desktop/main/index.ts)
- Main runtime wiring: [desktop/main/runtime.ts](/home/adamblumoff/gym-motion/desktop/main/runtime.ts)
- Managed runtime composition: [desktop/main/managed-gateway-runtime.ts](/home/adamblumoff/gym-motion/desktop/main/managed-gateway-runtime.ts)
- Child IPC persistence ingest: [desktop/main/managed-gateway-runtime/data-ingest.ts](/home/adamblumoff/gym-motion/desktop/main/managed-gateway-runtime/data-ingest.ts)
- Preload bridge: [desktop/preload/index.ts](/home/adamblumoff/gym-motion/desktop/preload/index.ts)
- Renderer runtime provider: [desktop/ui/src/app/runtime-context.tsx](/home/adamblumoff/gym-motion/desktop/ui/src/app/runtime-context.tsx)
- Windows gateway script: [desktop/scripts/windows-winrt-gateway.mjs](/home/adamblumoff/gym-motion/desktop/scripts/windows-winrt-gateway.mjs)
- Windows gateway child-to-main bridge: [desktop/scripts/windows-winrt-gateway-runtime-bridge.mjs](/home/adamblumoff/gym-motion/desktop/scripts/windows-winrt-gateway-runtime-bridge.mjs)
- Runtime server root: [backend/runtime/gateway-runtime-server/core.mjs](/home/adamblumoff/gym-motion/backend/runtime/gateway-runtime-server/core.mjs)
- Sidecar runtime root: [native/windows-ble-sidecar/src/windows/core_impl.rs](/home/adamblumoff/gym-motion/native/windows-ble-sidecar/src/windows/core_impl.rs)
- Sidecar session orchestration: [native/windows-ble-sidecar/src/windows/session.rs](/home/adamblumoff/gym-motion/native/windows-ble-sidecar/src/windows/session.rs)

## Ownership Map

- Sidecar (BLE transport truth):
  - [native/windows-ble-sidecar/src/windows/session_event.rs](/home/adamblumoff/gym-motion/native/windows-ble-sidecar/src/windows/session_event.rs)
  - [native/windows-ble-sidecar/src/windows/session_command.rs](/home/adamblumoff/gym-motion/native/windows-ble-sidecar/src/windows/session_command.rs)
  - [native/windows-ble-sidecar/src/windows/session_transport.rs](/home/adamblumoff/gym-motion/native/windows-ble-sidecar/src/windows/session_transport.rs)
- Runtime server (projection/cache only):
  - [backend/runtime/gateway-runtime-server/core.mjs](/home/adamblumoff/gym-motion/backend/runtime/gateway-runtime-server/core.mjs)
  - [backend/runtime/gateway-runtime-server/runtime-events.mjs](/home/adamblumoff/gym-motion/backend/runtime/gateway-runtime-server/runtime-events.mjs)
  - [backend/runtime/gateway-runtime-server/routes.mjs](/home/adamblumoff/gym-motion/backend/runtime/gateway-runtime-server/routes.mjs)
- Electron main (lifecycle, persistence, intent sequencing):
  - [desktop/main/runtime.ts](/home/adamblumoff/gym-motion/desktop/main/runtime.ts)
  - [desktop/main/managed-gateway-runtime/operator-intents.ts](/home/adamblumoff/gym-motion/desktop/main/managed-gateway-runtime/operator-intents.ts)
  - [desktop/main/managed-gateway-runtime/setup-state.ts](/home/adamblumoff/gym-motion/desktop/main/managed-gateway-runtime/setup-state.ts)
  - [desktop/main/managed-gateway-runtime/data-ingest.ts](/home/adamblumoff/gym-motion/desktop/main/managed-gateway-runtime/data-ingest.ts)
- Shared contracts and identity rules:
  - [shared/contracts.ts](/home/adamblumoff/gym-motion/shared/contracts.ts)
  - [shared/approved-node-runtime-match.ts](/home/adamblumoff/gym-motion/shared/approved-node-runtime-match.ts)
- Renderer (presentation and selectors):
  - [desktop/ui/src/app/runtime/use-desktop-app.ts](/home/adamblumoff/gym-motion/desktop/ui/src/app/runtime/use-desktop-app.ts)
  - [desktop/ui/src/app/selectors/dashboard.ts](/home/adamblumoff/gym-motion/desktop/ui/src/app/selectors/dashboard.ts)
  - [desktop/ui/src/app/selectors/setup.ts](/home/adamblumoff/gym-motion/desktop/ui/src/app/selectors/setup.ts)
  - [desktop/ui/src/app/selectors/analytics.ts](/home/adamblumoff/gym-motion/desktop/ui/src/app/selectors/analytics.ts)

## Fast Routing Guide

- Pair/forget/recover behavior incorrect:
  - start in [desktop/main/managed-gateway-runtime/operator-intents.ts](/home/adamblumoff/gym-motion/desktop/main/managed-gateway-runtime/operator-intents.ts)
- Node list, badges, setup row folding, or dashboard status looks wrong:
  - start in renderer selectors under [desktop/ui/src/app/selectors](/home/adamblumoff/gym-motion/desktop/ui/src/app/selectors)
- Runtime HTTP snapshot or stream projection is wrong:
  - start in [backend/runtime/gateway-runtime-server/runtime-events.mjs](/home/adamblumoff/gym-motion/backend/runtime/gateway-runtime-server/runtime-events.mjs)
- Device logs or telemetry are reaching the gateway console but not the per-device UI history:
  - start in [desktop/scripts/windows-winrt-gateway-runtime-bridge.mjs](/home/adamblumoff/gym-motion/desktop/scripts/windows-winrt-gateway-runtime-bridge.mjs)
  - then check [desktop/main/managed-gateway-runtime/data-ingest.ts](/home/adamblumoff/gym-motion/desktop/main/managed-gateway-runtime/data-ingest.ts)
- WinRT reconnect/handshake behavior is wrong:
  - start in [native/windows-ble-sidecar/src/windows/session_transport.rs](/home/adamblumoff/gym-motion/native/windows-ble-sidecar/src/windows/session_transport.rs)
  - then check [docs/bugs/windows-ble-bugs.md](/home/adamblumoff/gym-motion/docs/bugs/windows-ble-bugs.md)
