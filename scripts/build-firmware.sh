#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ARDUINO_CLI="$REPO_ROOT/bin/arduino-cli"

if [[ -n "${ARDUINO_CLI:-}" ]]; then
  ARDUINO_CLI_BIN="$ARDUINO_CLI"
elif [[ -x "$REPO_ARDUINO_CLI" ]]; then
  ARDUINO_CLI_BIN="$REPO_ARDUINO_CLI"
elif command -v arduino-cli >/dev/null 2>&1; then
  ARDUINO_CLI_BIN="$(command -v arduino-cli)"
else
  echo "arduino-cli is required. Install it or place an executable at $REPO_ARDUINO_CLI." >&2
  exit 1
fi

FQBN="${FQBN:-esp32:esp32:esp32}"
SKETCH_PATH="${SKETCH_PATH:-firmware/firmware.ino}"
BUILD_PATH="${BUILD_PATH:-build/firmware}"
PARTITIONS="${PARTITIONS:-min_spiffs}"

echo "Building reference BLE node firmware from $SKETCH_PATH"

"$ARDUINO_CLI_BIN" compile \
  --fqbn "$FQBN" \
  --board-options "PartitionScheme=$PARTITIONS" \
  --export-binaries \
  --output-dir "$BUILD_PATH" \
  "$SKETCH_PATH"

echo "Reference BLE node firmware exported to $BUILD_PATH"
