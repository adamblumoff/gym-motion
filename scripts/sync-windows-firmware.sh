#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SKETCH="${SOURCE_SKETCH:-$REPO_ROOT/gym_motion/gym_motion.ino}"
WINDOWS_SKETCH="${WINDOWS_SKETCH:-/mnt/c/Users/adamb/OneDrive/Desktop/gym_esp32_wifi_v1/gym_esp32_wifi_v1.ino}"

if [[ ! -f "$SOURCE_SKETCH" ]]; then
  echo "Source sketch not found: $SOURCE_SKETCH" >&2
  exit 1
fi

mkdir -p "$(dirname "$WINDOWS_SKETCH")"
cp "$SOURCE_SKETCH" "$WINDOWS_SKETCH"

if cmp -s "$SOURCE_SKETCH" "$WINDOWS_SKETCH"; then
  echo "Synced Windows firmware sketch:"
  echo "  source: $SOURCE_SKETCH"
  echo "  target: $WINDOWS_SKETCH"
else
  echo "Sketch sync failed verification." >&2
  exit 1
fi
