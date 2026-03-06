# AGENTS.md

## Arduino Sketch Sync Note

- Source-of-truth repo sketch: `/home/adamblumoff/gym-motion/gym_motion/gym_motion.ino`
- Windows Arduino IDE sketch to mirror after every repo `.ino` update: `/mnt/c/Users/adamb/OneDrive/Desktop/gym_esp32_wifi_v1/gym_esp32_wifi_v1.ino`
- Required workflow: whenever the repo `.ino` file changes, copy the updated repo version over to the Windows Arduino IDE file before the user opens/flashes it.
