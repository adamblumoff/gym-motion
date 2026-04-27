#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
project="$repo_root/native/linux-dotnet-ble-gateway/GymMotion.LinuxBleGateway.csproj"
tests="$repo_root/native/linux-dotnet-ble-gateway.tests/GymMotion.LinuxBleGateway.Tests.csproj"

dotnet build "$project"
dotnet test "$tests" --configuration Release
dotnet list "$project" package --include-transitive --vulnerable
bash "$script_dir/publish.sh"
