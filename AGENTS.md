# AGENTS.md

## Arduino Sketch Sync Note

- Source-of-truth repo sketch: `/home/adamblumoff/gym-motion/gym_motion/gym_motion.ino`
- Product framing note: this sketch is the current ESP32 reference implementation for a future BLE-only sensor node product. Avoid writing docs or scripts as if Wi-Fi-capable ESP32 hardware is the permanent node model.
- Windows Arduino IDE sketch to mirror after every repo `.ino` update: `/mnt/c/Users/adamb/OneDrive/Desktop/gym_esp32_wifi_v1/gym_esp32_wifi_v1.ino`
- Required workflow: whenever the repo `.ino` file changes, copy the updated repo version over to the Windows Arduino IDE file before the user opens/flashes it.
- Deployment rule: normal firmware rollouts should go through the OTA release flow, not manual Arduino uploads.
- Bench flashing rule: prefer `bun run firmware:upload -- --port <serial-port>` so USB flashes use the same partition settings as CI and OTA.
- Arduino IDE fallback: if you must flash from the IDE, use `ESP32 Dev Module` with `Partition Scheme -> Minimal SPIFFS (1.9MB APP with OTA/128KB SPIFFS)`.
- OTA release workflow:
  - before pushing, run the local manual QA gate:
    - `bun test`
    - `bun run lint`
    - `bun run build`
    - `bun run firmware:build`
  - push `main`
  - create and push a `firmware-vX.Y.Z` tag
  - let the GitHub `Firmware Release` workflow build, publish to the Railway bucket, and register the release
- The Windows Arduino IDE mirror is still needed for local bench compile/flash/debug, but it is not the primary deployment path for fleet updates.

## Environment Note

- Future environment strategy options and trade-offs are documented in `/home/adamblumoff/gym-motion/docs/development-environments.md`.
- Read this before changing how local dev, staging, production DBs, or production devices interact.
- The current desktop product should be treated as Windows-only. The supported BLE runtime path is Windows app + Rust WinRT sidecar + ESP32 firmware app-session lease protocol.
- Preferred Windows desktop validation flow: commit and push the repo state to test, clone into `C:\Users\adamb\Code\gym-motion`, then copy `.env.local` into that Windows repo before running `bun install` / `bun run dev` / `bun run build:win`.
- When working on the Windows desktop app, always commit and push before handing off so the Windows clone can pull the exact tested state.
- Windows desktop BLE now uses the native Rust WinRT sidecar so the built-in Windows Bluetooth adapter works. Do not route Windows back through the legacy noble + WinUSB path unless the user explicitly asks for a fallback experiment.
- The Windows BLE sidecar currently uses a vendored, locally patched `btleplug` at `/home/adamblumoff/gym-motion/native/windows-ble-sidecar/vendor/btleplug-winrt-patched` via `/home/adamblumoff/gym-motion/native/windows-ble-sidecar/Cargo.toml`. The active WinRT patch changes the reconnect transport to use `GattSession.MaintainConnection` before uncached GATT discovery. Treat that vendored crate as product code until we upstream it or replace it; do not silently switch back to the crates.io `btleplug` dependency.
- Non-Windows gateway BLE code still exists in the repo for legacy/dev support, but it is not the active product target and should not drive product decisions by default.
- On Windows, the app should auto-bind Bluetooth internally. The operator-facing `Setup` tab is for node connection and node management only, not adapter selection, and Bluetooth discovery should be manual-only rather than background scanning.
- Important reconnect regression note: do not keep WinRT scanning active while a reconnect handshake is in flight. That scan/connect overlap caused `connect()` and then `discover_services()` to report `Not connected` even though the ESP32 saw a BLE client, which prevented `app-session-bootstrap` and `app-session-lease` from ever being written and made the node drop the session as stale.
- Approved-node identity policy note: keep one desktop-core source of truth for matching order (`knownDeviceId`, then `peripheralId`, then BLE address, then unique `localName`). Do not re-implement that policy separately in setup UI, setup merging, or other Electron helpers.
- Ownership note: the WinRT sidecar owns BLE scan/reconnect/handshake truth, the firmware owns app-session lease truth, the runtime server owns projection/cache only, and Electron main owns persistence/app lifecycle.
- Verbose logging note: use `GATEWAY_VERBOSE=1` when you need the full WinRT reconnect trace. Normal mode should suppress step-by-step reconnect handshake info logs and repeated unchanged adapter snapshots, while warnings and errors stay visible.
- Windows desktop dev and packaging require the Rust MSVC toolchain because `bun run dev` and `bun run build:win` build `native/windows-ble-sidecar` locally.
- Current native Linux gateway bench host: `adam-blumoff@192.168.1.174`
- Quick connect command from the main dev machine: `ssh adam-blumoff@192.168.1.174`
- This host is likely on DHCP, so verify the IP before relying on it long-term.
- When the Linux gateway repo is being used for testing, keep it as a real GitHub clone and sync changes by pushing from this repo, then pulling on the Linux box before retesting.

## React / Next Note

- Follow Vercel React best practices for route data:
  - prefer server-seeded initial page data over client `useEffect` boot fetches
  - avoid large effects that fetch, parse, and set multiple page-level states
  - prefer one shared live subscription per page over multiple duplicate `EventSource` connections in nested widgets
