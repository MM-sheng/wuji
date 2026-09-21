#!/usr/bin/env bash
# Publish only the standalone public terminal. IPFS_PATH selects the operator's pin store.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ipfs_bin=${IPFS_BIN:-ipfs}
command -v "$ipfs_bin" >/dev/null || { echo 'Install Kubo, or set IPFS_BIN to its ipfs executable.' >&2; exit 1; }
stage=$(mktemp -d "${TMPDIR:-/tmp}/wuji-ipfs.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
mkdir "$stage/terminal"
cp "$repo/apps/terminal/index.html" "$stage/terminal/index.html"
# Explicit import options make the directory CID repeatable, independent of local profiles.
cid=$("$ipfs_bin" add --recursive --quieter --cid-version=1 --raw-leaves=true --chunker=size-262144 --hash=sha2-256 --wrap-with-directory=false --pin=true "$stage/terminal")
[[ "$cid" =~ ^b[a-z2-7]+$ ]] || { echo 'Kubo returned an invalid CID.' >&2; exit 1; }
"$ipfs_bin" pin ls --type=recursive "$cid" >/dev/null
# Read back the pinned bytes. A successful add alone does not prove the correct payload was pinned.
"$ipfs_bin" cat "/ipfs/$cid/index.html" > "$stage/readback.html"
cmp "$stage/terminal/index.html" "$stage/readback.html"
printf '%s\n' "$cid"
printf 'Pinned locally and read back: ipfs://%s/index.html\nKeep this node available or replicate the pin before publishing DNSLink.\n' "$cid" >&2
