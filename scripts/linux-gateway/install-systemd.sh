#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
service_template="$script_dir/gym-motion-linux-gateway.service"
service_target="/etc/systemd/system/gym-motion-linux-gateway.service"
env_file="$script_dir/linux-ble-gateway.env"
run_script="$script_dir/run.sh"
publish_script="$script_dir/publish.sh"
current_user="${SUDO_USER:-$USER}"

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file"
  echo "Create it first from:"
  echo "  cp \"$script_dir/linux-ble-gateway.env.example\" \"$env_file\""
  exit 1
fi

if [[ ! -x "$run_script" ]]; then
  chmod +x "$run_script"
fi

bash "$publish_script"

tmp_service="$(mktemp)"
trap 'rm -f "$tmp_service"' EXIT

sed \
  -e "s|__REPO_ROOT__|$repo_root|g" \
  -e "s|__ENV_FILE__|$env_file|g" \
  -e "s|__RUN_SCRIPT__|$run_script|g" \
  -e "s|__USER__|$current_user|g" \
  "$service_template" > "$tmp_service"

sudo cp "$tmp_service" "$service_target"
sudo systemctl daemon-reload
sudo systemctl enable --now gym-motion-linux-gateway.service
sudo systemctl status --no-pager gym-motion-linux-gateway.service
