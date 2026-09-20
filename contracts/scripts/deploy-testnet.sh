#!/usr/bin/env bash
# Deploy MockUSDT + MockWBNB + WujiIndex + WujiVaultFactory (+ 2 vaults) to BSC testnet.
# Signs from the encrypted keystore configured by scripts/set-key.sh (contracts/.env).
set -euo pipefail
cd "$(dirname "$0")/.."
# CREATE predictions require exclusive use of the deployer's nonce during simulation and broadcast.
# These local comparison keepers share contracts/.env. A stopped process is safe to resume after deployment.
for pidfile in /tmp/wuji-keeper.pid /tmp/wuji-bitcoin-keeper.pid /tmp/wuji-rewards-keeper.pid /tmp/wuji-reserve-keeper.pid /tmp/wuji-timestamps-keeper.pid; do
  if [[ -f "$pidfile" ]]; then
    keeper_pid=$(cat "$pidfile")
    if [[ "$keeper_pid" =~ ^[0-9]+$ ]] && kill -0 "$keeper_pid" 2>/dev/null; then
      keeper_state=$(ps -p "$keeper_pid" -o stat=)
      if [[ "$keeper_state" != *T* ]]; then
        echo "Pause the keeper in $pidfile before deploying, then resume it afterwards." >&2
        exit 1
      fi
    fi
  fi
done
set -a; source "${ENV_FILE:-.env}"; set +a
set -a; source deployments/bitcoin-checkpoint.env; set +a
export RPC="${DEPLOY_RPC:-$RPC}"
export ALLOW_MOCK_ASSET=true EXPECTED_CHAIN_ID=97
# Password-file paths in an external env belong to that env's directory.
if [[ "$PASSWORD_FILE" != /* ]]; then PASSWORD_FILE="$(dirname "${ENV_FILE:-$PWD/.env}")/$PASSWORD_FILE"; fi
export PASSWORD_FILE
"${FORGE:-$HOME/.foundry/bin/forge}" script script/Deploy.s.sol --rpc-url "$RPC" --broadcast \
  --account "$KEYSTORE_ACCOUNT" --password-file "$PASSWORD_FILE" --sender "$DEPLOYER" -vv
