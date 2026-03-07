# AGENTS.md

## Arduino Sketch Sync Note

- Source-of-truth repo sketch: `/home/adamblumoff/gym-motion/gym_motion/gym_motion.ino`
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
