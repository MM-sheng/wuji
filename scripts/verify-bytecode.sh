#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
forge_bin=${FORGE:-forge}
if ! command -v "$forge_bin" >/dev/null 2>&1; then forge_bin="$HOME/.foundry/bin/forge"; fi
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/wuji-bytecode.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT
# New output/cache directories: no prior artifact can satisfy this verification.
FOUNDRY_PROFILE=default "$forge_bin" build --root "$root/contracts" --out "$build_dir/out" --cache-path "$build_dir/cache" --build-info --force >&2
node "$root/scripts/build-reproducible.mjs" "$root" "$build_dir/out"
node "$root/scripts/verify-bytecode.mjs" "${1:-$root/contracts/deployments/sepolia-weth-v3.json}" "$build_dir/out"
