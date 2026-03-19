#!/usr/bin/env bash

set -euo pipefail

INSTALL_DIR="${ARDUINO_CLI_INSTALL_DIR:-$HOME/.local/bin}"
DOWNLOAD_URL="${ARDUINO_CLI_DOWNLOAD_URL:-https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Linux_64bit.tar.gz}"

mkdir -p "$INSTALL_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ARCHIVE_PATH="$TMP_DIR/arduino-cli.tar.gz"

curl -fsSL "$DOWNLOAD_URL" -o "$ARCHIVE_PATH"
tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"
install -m 0755 "$TMP_DIR/arduino-cli" "$INSTALL_DIR/arduino-cli"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$INSTALL_DIR" >> "$GITHUB_PATH"
fi

"$INSTALL_DIR/arduino-cli" version
