#!/usr/bin/env bash
# Restore the read-only frontend for the current v3 operator. Existing keeper jobs stay independent.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import hashlib, json, os, plistlib, subprocess
from pathlib import Path

root=Path.cwd()
j=json.loads((root/'contracts/deployments/sepolia-header-v3.json').read_text())
assert j['chainId']==11155111 and j['WujiHeaderIndex'].lower()=='0x4a70ebc03da98f04d88964e17df212ba1bb2705a'
op=root/'operator/sepolia-header-v3'
runtime=op/'runtime'
record=json.loads((op/'runtime-source.json').read_text())
for f in record['files']:
    assert hashlib.sha256((runtime/'indexer'/f['path']).read_bytes()).hexdigest()==f['sha256'], 'operator runtime changed: '+f['path']
assert (runtime/'apps/terminal/index.html').is_file(), 'restore the matching terminal snapshot first'
node=Path.home()/'.local/bin/node'
assert node.is_file()
label='com.wuji.sepolia-header-v3-indexer'
env={'SOURCE':'bitcoin','CHAIN_ID':'11155111','RPC':j['rpc'],'CONTRACT':j['WujiHeaderIndex'],
     'GENESIS_HEIGHT':str(j['genesisHeight']),'PORT':'8796',
     'ACCOUNTS':','.join(p['address'] for p in j['accounts']['pools']),
     'DATA_DIR':str(op/'indexer-data'),'BITCOIN_SOURCE':'http',
     'PATH':'/Users/m/.local/bin:/opt/homebrew/bin:/usr/bin:/bin'}
job={'Label':label,'ProgramArguments':[str(node),str(runtime/'indexer/index.mjs')],
     'WorkingDirectory':str(runtime),'EnvironmentVariables':env,'KeepAlive':True,'RunAtLoad':True,
     'ThrottleInterval':30,'StandardOutPath':str(op/'indexer.log'),'StandardErrorPath':str(op/'indexer.log')}
agent=Path.home()/'Library/LaunchAgents'/f'{label}.plist'
if agent.exists():
    assert plistlib.loads(agent.read_bytes())==job, 'existing indexer job differs; inspect before replacing'
else:
    agent.write_bytes(plistlib.dumps(job))
domain='gui/'+str(os.getuid())
running=subprocess.run(['launchctl','print',domain+'/'+label],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
if not running:subprocess.run(['launchctl','bootstrap',domain,str(agent)],check=True)
print('v3 indexer supervised by launchd: http://localhost:8796')
for role in ('keeper','lifecycle'):
    label='com.wuji.sepolia-header-v3-'+role
    result=subprocess.run(['launchctl','print',domain+'/'+label],capture_output=True,text=True)
    print(role+': '+('registered' if result.returncode==0 else 'not registered; inspect operator setup'))
PY
