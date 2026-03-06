#!/usr/bin/env bash

set -euo pipefail

FQBN="${FQBN:-esp32:esp32:esp32}"
SKETCH_PATH="${SKETCH_PATH:-gym_motion/gym_motion.ino}"
BUILD_PATH="${BUILD_PATH:-build/firmware}"
PARTITIONS="${PARTITIONS:-min_spiffs}"

arduino-cli compile \
  --fqbn "$FQBN" \
  --build-property "build.partitions=$PARTITIONS" \
  --export-binaries \
  --output-dir "$BUILD_PATH" \
  "$SKETCH_PATH"

echo "Firmware build exported to $BUILD_PATH"
