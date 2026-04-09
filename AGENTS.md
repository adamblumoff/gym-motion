It's imperative to make stuff as simple as possible, less is better than more. We can make things more complex in the future. 

Use js_repl for validation of code changes on the frontend, reuse the user's already-running dev instance instead of starting a new one unless you are already running one on the user's request. 

## Repo Policy

- Architectural truth in this repo must be derived from current code, tests, scripts, configs, and observed behavior.
- Do not treat architecture, vision, or code-map docs as source-of-truth, even if they still exist in git history.
- [docs/bugs/windows-ble-bugs.md](/home/adamblumoff/gym-motion/docs/bugs/windows-ble-bugs.md) is historical bug memory only. Use it for context, then verify everything against the current repo before acting on it.
- Prefer repo-owned command surfaces like `bun run test`, `bun run lint`, `bun run typecheck`, and other package scripts over ad hoc command variants.

## Firmware Notes

- Source-of-truth sketch: `/home/adamblumoff/gym-motion/firmware/firmware.ino`
- For bench USB flashing, prefer `bun run firmware:upload -- --port <serial-port>` so local flashes match the repo's OTA/CI partition settings.
- After firmware changes, try a bench USB upload with `bun run firmware:upload -- --port <serial-port>` before handoff when hardware access is available and the local environment supports it.

## Windows Desktop Notes

- The active desktop product path is Windows-only.
- The supported BLE runtime path is Windows app + Rust WinRT sidecar + firmware app-session protocol.
- Do not reintroduce the older noble/WinUSB BLE fallback.
- The WinRT sidecar depends on the vendored patched `btleplug` at `/home/adamblumoff/gym-motion/native/windows-ble-sidecar/vendor/btleplug-winrt-patched`; treat it as product code.
- Validate desktop changes from the current Windows repo checkout with `.env.local` present before running `bun install`, `bun run dev`, or `bun run build:win`.
- Windows desktop dev and packaging require the Rust MSVC toolchain because the native sidecar is built locally.
