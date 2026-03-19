# AGENTS.md

## Repo Policy

- Architectural truth in this repo must be derived from current code, tests, scripts, configs, and observed behavior.
- Do not treat architecture, vision, or code-map docs as source-of-truth, even if they still exist in git history.
- [docs/bugs/windows-ble-bugs.md](/home/adamblumoff/gym-motion/docs/bugs/windows-ble-bugs.md) is historical bug memory only. Use it for context, then verify everything against the current repo before acting on it.
- Prefer repo-owned command surfaces like `bun run test`, `bun run lint`, `bun run typecheck`, and other package scripts over ad hoc command variants.

## Firmware Notes

- Source-of-truth sketch: `/home/adamblumoff/gym-motion/firmware/firmware.ino`
- Normal firmware rollouts should go through the OTA release flow, not manual Arduino uploads.
- For bench USB flashing, prefer `bun run firmware:upload -- --port <serial-port>` so local flashes match the repo's OTA/CI partition settings.

## Windows Desktop Notes

- The active desktop product path is Windows-only.
- The supported BLE runtime path is Windows app + Rust WinRT sidecar + ESP32 firmware app-session protocol.
- Do not reintroduce the older noble/WinUSB BLE fallback.
- The WinRT sidecar depends on the vendored patched `btleplug` at `/home/adamblumoff/gym-motion/native/windows-ble-sidecar/vendor/btleplug-winrt-patched`; treat it as product code.
- Prefer validating desktop changes from a Windows clone at `C:\Users\adamb\Code\gym-motion` with `.env.local` copied in before running `bun install`, `bun run dev`, or `bun run build:win`.
- Windows desktop dev and packaging require the Rust MSVC toolchain because the native sidecar is built locally.
- Unless the user explicitly says not to, finish Windows desktop changes by committing and pushing the tested branch before handoff.
