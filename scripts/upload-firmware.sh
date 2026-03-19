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

PORT=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="$2"
      shift 2
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$PORT" ]]; then
  echo "usage: bun run firmware:upload -- --port <serial-port> [extra arduino-cli args]" >&2
  exit 1
fi

FQBN="${FQBN:-esp32:esp32:esp32}"
SKETCH_PATH="${SKETCH_PATH:-firmware/firmware.ino}"
PARTITIONS="${PARTITIONS:-min_spiffs}"

"$ARDUINO_CLI_BIN" upload \
  --fqbn "$FQBN" \
  --board-options "PartitionScheme=$PARTITIONS" \
  --port "$PORT" \
  "${EXTRA_ARGS[@]}" \
  "$SKETCH_PATH"
