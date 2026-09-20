#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --test indexer/bitcoin.test.mjs
"${FORGE:-$HOME/.foundry/bin/forge}" test --root contracts --match-contract BitcoinRelayTest
