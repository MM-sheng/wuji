#!/usr/bin/env bash
# Deploy MockUSDT + MockWBNB + WujiIndex + WujiVaultFactory (+ 2 vaults) to BSC testnet.
# Signs from the encrypted keystore configured by scripts/set-key.sh (contracts/.env).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source "${ENV_FILE:-.env}"; set +a
set -a; source deployments/bitcoin-checkpoint.env; set +a
export ALLOW_MOCK_ASSET=true EXPECTED_CHAIN_ID=97
# Password-file paths in an external env belong to that env's directory.
if [[ "$PASSWORD_FILE" != /* ]]; then PASSWORD_FILE="$(dirname "${ENV_FILE:-$PWD/.env}")/$PASSWORD_FILE"; fi
export PASSWORD_FILE
"${FORGE:-$HOME/.foundry/bin/forge}" script script/Deploy.s.sol --rpc-url "$RPC" --broadcast \
  --account "$KEYSTORE_ACCOUNT" --password-file "$PASSWORD_FILE" --sender "$DEPLOYER" -vv
