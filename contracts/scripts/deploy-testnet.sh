#!/usr/bin/env bash
# Deploy MockUSDT + MockWBNB + WujiIndex + WujiVaultFactory (+ 2 vaults) to BSC testnet.
# Signs from the encrypted keystore configured by scripts/set-key.sh (contracts/.env).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
export ALLOW_MOCK_ASSET=true EXPECTED_CHAIN_ID=97 SERIES_BLOCKS="${SERIES_BLOCKS:-8000}"
"${FORGE:-$HOME/.foundry/bin/forge}" script script/Deploy.s.sol --rpc-url "$RPC" --broadcast \
  --account "$KEYSTORE_ACCOUNT" --password-file "$PASSWORD_FILE" --sender "$DEPLOYER" -vv
