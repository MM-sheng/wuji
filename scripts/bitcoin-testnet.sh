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
assert j['chainId'] in (97,11155111), 'testnets only'
sepolia=j['chainId']==11155111
v4=j.get('version')=='bitcoin-sepolia-v4'
assert j.get('status') == 'confirmed' if sepolia else j.get('status') in (None,'confirmed'), 'deployment receipts not confirmed'
env=os.environ.copy();env.update(SOURCE='bitcoin',PORT=os.environ.get('PORT','8794' if v4 else '8793' if sepolia else '8789'),CHAIN_ID=str(j['chainId']),GENESIS_HEIGHT=str(j['genesisHeight']),RELAY=j['BitcoinRelay'],CONTRACT=j['WujiIndex'],FACTORY=j['WujiVaultFactory'],RPC=os.environ.get('RPC_OVERRIDE') or j['rpc'],FEE_ROUTER=j.get('FeeRouter',''))
if j.get('version') in ('bitcoin-reserve-v2','bitcoin-timestamps-v3','bitcoin-sepolia-v3','bitcoin-sepolia-v4'):
 env.update(REWARD_MODEL='operations-reserve',REWARDS=j['RelayerRewards'],REWARD_TOKENS=os.environ.get('REWARD_TOKENS',','.join(j['rewardTokens'])))
if j.get('version') in ('bitcoin-timestamps-v3','bitcoin-sepolia-v3','bitcoin-sepolia-v4'):
 env.update(RELAY_TIMESTAMPS='1',KEEPER_GAS_PRICE=os.environ.get('KEEPER_GAS_PRICE','' if sepolia else '0.1gwei'))
env.update(FROZEN_EXIT='1' if v4 else '0')
if sepolia:
 env.setdefault('DATA_DIR',str(Path('indexer/data/sepolia-v4' if j.get('version')=='bitcoin-sepolia-v4' else 'indexer/data/sepolia-v3').resolve()))
prefix=os.environ.get('PROCESS_PREFIX','wuji-sepolia-v4' if v4 else 'wuji-sepolia' if sepolia else 'wuji-bitcoin')
processes=[('indexer','indexer/index.mjs')]
if os.environ.get('RUN_KEEPER','1')!='0': processes.append(('keeper','indexer/keeper.mjs'))
for name,script in processes:
 pidfile=Path('/tmp/'+prefix+'-'+name+'.pid')
 if pidfile.exists():
  try:
   os.kill(int(pidfile.read_text()),0);print(name+' already running');continue
  except ProcessLookupError: pass
 with open('/tmp/'+prefix+'-'+name+'.log','a') as log:
  p=subprocess.Popen(['node',script],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 pidfile.write_text(str(p.pid));print(name,p.pid)
PY
