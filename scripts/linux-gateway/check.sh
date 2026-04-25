#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
project="$repo_root/native/linux-dotnet-ble-gateway/GymMotion.LinuxBleGateway.csproj"

dotnet build "$project"
dotnet list "$project" package --include-transitive --vulnerable
"$script_dir/publish.sh"
