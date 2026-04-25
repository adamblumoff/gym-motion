#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
project="$repo_root/native/linux-dotnet-ble-gateway/GymMotion.LinuxBleGateway.csproj"
publish_dir="$repo_root/native/linux-dotnet-ble-gateway/out"

rm -rf "$publish_dir"

dotnet publish "$project" \
  --configuration Release \
  --output "$publish_dir" \
  --no-self-contained

echo "Published Linux gateway to $publish_dir"
