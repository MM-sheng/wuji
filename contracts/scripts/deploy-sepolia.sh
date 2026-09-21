#!/usr/bin/env bash
# Dry run by default. Pass --broadcast only after tests and reviewing the simulation.
set -euo pipefail
cd "$(dirname "$0")/.."
export ENV_FILE="${ENV_FILE:-$PWD/.env.sepolia}"
set -a; source "$ENV_FILE"; source deployments/bitcoin-checkpoint.env; set +a
if [[ "$PASSWORD_FILE" != /* ]]; then export PASSWORD_FILE="$(dirname "$ENV_FILE")/$PASSWORD_FILE"; fi
export RPC="${DEPLOY_RPC:-$RPC}"
export EXPECTED_CHAIN_ID=11155111 ALLOW_MOCK_ASSET=false CHECKPOINT_INTERVAL=4320
export VAULTS='0xfff9976782d46cc05630d1f6ebab18b2324d6b14:1000000000000000'
cast_bin="${CAST:-$HOME/.foundry/bin/cast}"
[[ "$("$cast_bin" chain-id --rpc-url "$RPC")" == 11155111 ]] || { echo 'Wrong RPC chain' >&2; exit 1; }
[[ "$("$cast_bin" wallet address --account "$KEYSTORE_ACCOUNT" --password-file "$PASSWORD_FILE" | tr '[:upper:]' '[:lower:]')" == "$(echo "$DEPLOYER" | tr '[:upper:]' '[:lower:]')" ]] || { echo 'Deployer does not match keystore' >&2; exit 1; }
[[ "$KEYSTORE_ACCOUNT" != wuji-testnet ]] || { echo 'Use a separate Sepolia account' >&2; exit 1; }
args=(script script/Deploy.s.sol --rpc-url "$RPC" --rpc-timeout 45 --fork-retries 2)
if [[ "${1:-}" == --broadcast && $# == 1 ]]; then
  for pidfile in /tmp/wuji-sepolia-keeper.pid /tmp/wuji-sepolia-v4-keeper.pid; do
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo 'Stop Sepolia keepers before broadcasting a deployment from the shared nonce' >&2; exit 1
    fi
  done
  [[ "$("$cast_bin" nonce "$DEPLOYER" --block pending --rpc-url "$RPC")" == "$("$cast_bin" nonce "$DEPLOYER" --block latest --rpc-url "$RPC")" ]] || { echo 'Pending transaction: wait for confirmation before deploying' >&2; exit 1; }
  args+=(--broadcast);
elif [[ $# != 0 ]]; then echo 'Usage: deploy-sepolia.sh [--broadcast]' >&2; exit 1; fi
"${FORGE:-$HOME/.foundry/bin/forge}" "${args[@]}" \
  --account "$KEYSTORE_ACCOUNT" --password-file "$PASSWORD_FILE" --sender "$DEPLOYER" -vv
