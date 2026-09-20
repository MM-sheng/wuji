// Load public deployment wiring; credentials remain paths to read-only mounted files.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
export function containerEnv(manifest,env,role){
 assert.ok(['indexer','keeper'].includes(role),'role must be indexer or keeper');
 assert.equal(manifest.status,'confirmed','deployment must be confirmed');
 assert.ok(['bitcoin-timestamps-v3','bitcoin-sepolia-v3'].includes(manifest.version),'use a current timestamp-checking v3 manifest');
 assert.ok([97,11155111].includes(manifest.chainId),'container example supports testnets only');
 assert.ok(Number.isSafeInteger(manifest.genesisHeight)&&manifest.genesisHeight>0,'invalid genesis');
 for(const name of ['WujiIndex','BitcoinRelay','WujiVaultFactory','FeeRouter','RelayerRewards'])assert.match(manifest[name],/^0x[0-9a-fA-F]{40}$/,'invalid '+name);
 const tokens=[...new Set(Object.values(manifest.vaults).map(v=>v.asset.toLowerCase()))].sort();
 assert.ok(tokens.length>0&&tokens.length<=8&&tokens.every(t=>/^0x[0-9a-f]{40}$/.test(t)),'invalid reward assets');
 const result={...env,SOURCE:'bitcoin',CHAIN_ID:String(manifest.chainId),GENESIS_HEIGHT:String(manifest.genesisHeight),CONTRACT:manifest.WujiIndex,RELAY:manifest.BitcoinRelay,FACTORY:manifest.WujiVaultFactory,FEE_ROUTER:manifest.FeeRouter,REWARDS:manifest.RelayerRewards,REWARD_MODEL:'operations-reserve',RELAY_TIMESTAMPS:'1',REWARD_TOKENS:tokens.join(','),RPC:env.RPC||manifest.rpc,PORT:env.PORT||'8789',DATA_DIR:env.DATA_DIR||'/data',CAST:env.CAST||'/usr/local/bin/cast'};
 if(role==='keeper'){
  assert.match(env.KEYSTORE_ACCOUNT||'',/^[a-zA-Z0-9_-]+$/,'set KEYSTORE_ACCOUNT (name only)');
  assert.ok(env.PASSWORD_FILE?.startsWith('/'),'set an absolute PASSWORD_FILE');
  result.KEEPER_GAS_PRICE=env.KEEPER_GAS_PRICE??(manifest.chainId===97?'0.1gwei':'');
 }
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
 try{
  const role=process.argv[2]||'indexer',file=process.env.MANIFEST||'contracts/deployments/sepolia-weth-v3.json';
  const env=containerEnv(JSON.parse(fs.readFileSync(file,'utf8')),process.env,role);
  if(role==='keeper'){
   for(const p of [env.PASSWORD_FILE,`${env.HOME}/.foundry/keystores/${env.KEYSTORE_ACCOUNT}`])assert.ok(fs.statSync(p).isFile(),'mount the encrypted keystore and password as files');
  }
  Object.assign(process.env,env);await import(`../indexer/${role==='indexer'?'index':'keeper'}.mjs`);
 }catch(e){console.error('Startup failed:',e.message);process.exitCode=1;}
}
