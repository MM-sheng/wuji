#!/usr/bin/env bash
# Run the testnet stack: indexer (port 8788) following BSC testnet from the deployed genesis, plus the keeper.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source contracts/.env; set +a
D=contracts/deployments/bsc-testnet.json
j() { python3 -c "import json;print(json.load(open('$D'))['$1'])"; }
export RPC CONTRACT=$(j WujiIndex) VAULT=$(j WujiVault) GENESIS_BLOCK=$(j genesisBlock)
nohup env PORT=8788 node indexer/index.mjs > /tmp/wuji-testnet-indexer.log 2>&1 < /dev/null &
echo $! > /tmp/wuji-testnet-indexer.pid
nohup node indexer/keeper.mjs > /tmp/wuji-keeper.log 2>&1 < /dev/null &
echo $! > /tmp/wuji-keeper.pid
echo "testnet indexer :8788 (log /tmp/wuji-testnet-indexer.log), keeper (log /tmp/wuji-keeper.log)"
