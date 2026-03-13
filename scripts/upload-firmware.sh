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

PORT="${PORT:-}"
FQBN="${FQBN:-esp32:esp32:esp32}"
SKETCH_PATH="${SKETCH_PATH:-gym_motion/gym_motion.ino}"
BUILD_PATH="${BUILD_PATH:-build/firmware}"
PARTITIONS="${PARTITIONS:-min_spiffs}"
VERIFY_UPLOAD="${VERIFY_UPLOAD:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --verify)
      VERIFY_UPLOAD=1
      shift
      ;;
    *)
      echo "Unsupported argument: $1" >&2
      echo "Usage: $0 --port <serial-port> [--verify]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PORT" ]]; then
  echo "A serial port is required. Pass --port <serial-port> or set PORT." >&2
  exit 1
fi

echo "Uploading reference BLE node firmware to $PORT"

"$REPO_ROOT/scripts/build-firmware.sh"

UPLOAD_ARGS=(
  upload
  --fqbn "$FQBN"
  --board-options "PartitionScheme=$PARTITIONS"
  --input-dir "$BUILD_PATH"
  --port "$PORT"
)

if [[ "$VERIFY_UPLOAD" == "1" ]]; then
  UPLOAD_ARGS+=(--verify)
fi

"$ARDUINO_CLI_BIN" "${UPLOAD_ARGS[@]}"

echo "Reference BLE node firmware uploaded to $PORT using $FQBN with PartitionScheme=$PARTITIONS"
