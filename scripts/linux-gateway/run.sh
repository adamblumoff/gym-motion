#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
env_file="$script_dir/linux-ble-gateway.env"
default_nodes_file="$script_dir/linux-ble-gateway.nodes.json"
example_nodes_file="$script_dir/linux-ble-gateway.nodes.example.json"
gateway_dll="$repo_root/native/linux-dotnet-ble-gateway/out/gym-motion-ble-linux.dll"

if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

gateway_id="${1:-${GYM_MOTION_GATEWAY_ID:-}}"
backend_url="${GYM_MOTION_CLOUD_API_BASE_URL:-https://gym-motion-production.up.railway.app}"
nodes_file="${GYM_MOTION_GATEWAY_NODES_FILE:-$default_nodes_file}"
adapter="${GYM_MOTION_GATEWAY_ADAPTER:-hci0}"

if [[ -z "$gateway_id" ]]; then
  echo "Missing gateway id."
  echo "Set GYM_MOTION_GATEWAY_ID in scripts/linux-gateway/linux-ble-gateway.env or pass it as the first argument."
  exit 1
fi

if [[ ! -f "$nodes_file" ]]; then
  echo "Missing nodes file: $nodes_file"
  echo "Create it first, for example:"
  echo "  cp \"$example_nodes_file\" \"$default_nodes_file\""
  exit 1
fi

if [[ ! -f "$gateway_dll" ]]; then
  echo "Missing published gateway: $gateway_dll"
  echo "Publish it first with:"
  echo "  bash \"$script_dir/publish.sh\""
  exit 1
fi

exec dotnet "$gateway_dll" \
  --gateway-id "$gateway_id" \
  --nodes-file "$nodes_file" \
  --backend-url "$backend_url" \
  --adapter "$adapter"
