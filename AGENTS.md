# AGENTS.md

## Arduino Sketch Sync Note

- Source-of-truth repo sketch: `/home/adamblumoff/gym-motion/gym_motion/gym_motion.ino`
- Windows Arduino IDE sketch to mirror after every repo `.ino` update: `/mnt/c/Users/adamb/OneDrive/Desktop/gym_esp32_wifi_v1/gym_esp32_wifi_v1.ino`
- Required workflow: whenever the repo `.ino` file changes, copy the updated repo version over to the Windows Arduino IDE file before the user opens/flashes it.
- Deployment rule: normal firmware rollouts should go through the OTA release flow, not manual Arduino uploads.
- OTA release workflow:
  - push `main`
  - create and push a `firmware-vX.Y.Z` tag
  - let the GitHub `Firmware Release` workflow build, publish to the Railway bucket, and register the release
- The Windows Arduino IDE mirror is still needed for local bench compile/flash/debug, but it is not the primary deployment path for fleet updates.
