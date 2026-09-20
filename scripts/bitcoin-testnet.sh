#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ENV_FILE="${ENV_FILE:-$PWD/contracts/.env}"
set -a; source "$ENV_FILE"; set +a
if [[ "$PASSWORD_FILE" != /* ]]; then export PASSWORD_FILE="$(dirname "$ENV_FILE")/$PASSWORD_FILE"; fi
python3 - <<'PY'
import json,os,subprocess
from pathlib import Path
j=json.load(open(os.environ.get('MANIFEST','contracts/deployments/bsc-testnet.json')))
env=os.environ.copy();env.update(SOURCE='bitcoin',PORT=os.environ.get('PORT','8789'),CHAIN_ID='97',GENESIS_HEIGHT=str(j['genesisHeight']),RELAY=j['BitcoinRelay'],CONTRACT=j['WujiIndex'],FACTORY=j['WujiVaultFactory'],RPC=j['rpc'],FEE_ROUTER=j.get('FeeRouter',''))
if j.get('version') == 'bitcoin-reserve-v2':
 env.update(REWARD_MODEL='operations-reserve',REWARDS=j['RelayerRewards'],REWARD_TOKENS=os.environ.get('REWARD_TOKENS',','.join(j['rewardTokens'])))
prefix=os.environ.get('PROCESS_PREFIX','wuji-bitcoin')
for name,script in [('indexer','indexer/index.mjs'),('keeper','indexer/keeper.mjs')]:
 pidfile=Path('/tmp/'+prefix+'-'+name+'.pid')
 if pidfile.exists():
  try:
   os.kill(int(pidfile.read_text()),0);print(name+' already running');continue
  except ProcessLookupError: pass
 with open('/tmp/'+prefix+'-'+name+'.log','a') as log:
  p=subprocess.Popen(['node',script],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 pidfile.write_text(str(p.pid));print(name,p.pid)
PY
