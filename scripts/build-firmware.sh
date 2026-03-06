#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARDUINO_CLI="${ARDUINO_CLI:-$REPO_ROOT/bin/arduino-cli}"

FQBN="${FQBN:-esp32:esp32:esp32}"
SKETCH_PATH="${SKETCH_PATH:-gym_motion/gym_motion.ino}"
BUILD_PATH="${BUILD_PATH:-build/firmware}"
PARTITIONS="${PARTITIONS:-min_spiffs}"

"$ARDUINO_CLI" compile \
  --fqbn "$FQBN" \
  --board-options "PartitionScheme=$PARTITIONS" \
  --export-binaries \
  --output-dir "$BUILD_PATH" \
  "$SKETCH_PATH"

echo "Firmware build exported to $BUILD_PATH"
