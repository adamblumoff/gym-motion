#!/usr/bin/env bash

set -euo pipefail

python3 -m pip install --user adafruit-nrfutil

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$HOME/.local/bin" >> "$GITHUB_PATH"
fi

"$HOME/.local/bin/adafruit-nrfutil" version
