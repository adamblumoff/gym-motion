#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ARDUINO_CLI="$REPO_ROOT/bin/arduino-cli"

find_windows_arduino_cli() {
  local candidate=""

  for candidate in \
    "/mnt/c/ProgramData/chocolatey/bin/arduino-cli.exe" \
    "/c/ProgramData/chocolatey/bin/arduino-cli.exe" \
    "/mnt/c/Program Files/Arduino CLI/arduino-cli.exe" \
    "/c/Program Files/Arduino CLI/arduino-cli.exe"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v powershell.exe >/dev/null 2>&1; then
    candidate="$(powershell.exe -NoProfile -Command "(Get-Command arduino-cli -ErrorAction SilentlyContinue).Source" 2>/dev/null | tr -d '\r')"
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  return 1
}

if [[ -n "${ARDUINO_CLI:-}" ]]; then
  ARDUINO_CLI_BIN="$ARDUINO_CLI"
elif [[ -x "$REPO_ARDUINO_CLI" ]]; then
  ARDUINO_CLI_BIN="$REPO_ARDUINO_CLI"
elif command -v arduino-cli >/dev/null 2>&1; then
  ARDUINO_CLI_BIN="$(command -v arduino-cli)"
elif ARDUINO_CLI_BIN="$(find_windows_arduino_cli)"; then
  :
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

FQBN="${FQBN:-Seeeduino:nrf52:xiaonRF52840:softdevice=s140v6,debug=l0}"
SKETCH_PATH="${SKETCH_PATH:-firmware/firmware.ino}"
PARTITIONS="${PARTITIONS:-min_spiffs}"
BUILD_TAG="${BUILD_TAG:-}"

if [[ -z "$BUILD_TAG" ]] && command -v git >/dev/null 2>&1; then
  if BUILD_TAG="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null)"; then
    if ! git -C "$REPO_ROOT" diff --quiet --no-ext-diff --exit-code 2>/dev/null; then
      BUILD_TAG="${BUILD_TAG}_dirty"
    fi
  else
    BUILD_TAG="unknown"
  fi
fi

BUILD_TAG="${BUILD_TAG:-unknown}"
compile_args=(
  --fqbn "$FQBN"
  --port "$PORT"
  --upload
  --clean
  --build-property "compiler.cpp.extra_flags=-DGM_BUILD_TAG=$BUILD_TAG"
)

if [[ "$FQBN" == esp32:* ]]; then
  compile_args+=(--board-options "PartitionScheme=$PARTITIONS")
fi

echo "Compiling and uploading firmware from $SKETCH_PATH to $PORT"
echo "Embedding firmware build tag $BUILD_TAG"

"$ARDUINO_CLI_BIN" compile \
  "${compile_args[@]}" \
  "${EXTRA_ARGS[@]}" \
  "$SKETCH_PATH"
