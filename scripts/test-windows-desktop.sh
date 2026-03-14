#!/usr/bin/env bash
set -euo pipefail

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "powershell.exe is not available from this WSL environment."
  exit 1
fi

exe_path="$(find release -type f -name '*.exe' | sort | tail -n 1)"

if [[ -z "${exe_path}" ]]; then
  echo "No Windows desktop executable found under release/."
  echo "Build the packaged app first, then rerun this helper."
  exit 1
fi

win_path="$(wslpath -w "${exe_path}")"

echo "Launching ${exe_path}"
powershell.exe -NoProfile -Command "Start-Process -FilePath '${win_path}'"
