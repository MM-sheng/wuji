#!/usr/bin/env bash
# Deploy MockUSDT + WujiIndex + WujiVault to BSC testnet using contracts/.env (PRIVATE_KEY, RPC).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
export ALLOW_MOCK_ASSET=true EXPECTED_CHAIN_ID=97
"${FORGE:-$HOME/.foundry/bin/forge}" script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$PRIVATE_KEY" -vv
