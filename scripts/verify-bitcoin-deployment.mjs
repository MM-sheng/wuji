import fs from 'node:fs';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import os from 'node:os';import path from 'node:path';
import {BitcoinAPI,step} from '../indexer/bitcoin.mjs';
const j=JSON.parse(fs.readFileSync(process.env.MANIFEST||'contracts/deployments/bsc-testnet.json'));
const reserveMode=['bitcoin-reserve-v2','bitcoin-timestamps-v3'].includes(j.version);
async function rpc(method,params){const r=await(await fetch(j.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)})).json();if(r.error)throw Error(r.error.message);return r.result;}
assert.equal(Number(BigInt(await rpc('eth_chainId',[]))),97);
const verified=[];
for(const [name,address] of [...['BitcoinRelay','WujiIndex','SeriesTokenDeployer','WujiVaultFactory','RelayerRewards','FeeRouter'].filter(n=>j[n]).map(n=>[n,j[n]]),...Object.values(j.vaults).map(v=>['WujiVault',v.address])]){
 const artifact=JSON.parse(fs.readFileSync(`contracts/out/${name==='SeriesTokenDeployer'?'SeriesToken':name}.sol/${name}.json`));
 const actual=Buffer.from((await rpc('eth_getCode',[address,'latest'])).slice(2),'hex');
 const expected=Buffer.from(artifact.deployedBytecode.object.replace(/^0x/,''),'hex');assert.equal(actual.length,expected.length);
 for(const refs of Object.values(artifact.deployedBytecode.immutableReferences||{}))for(const {start,length} of refs){actual.fill(0,start,start+length);expected.fill(0,start,start+length);}
 assert.deepEqual(actual,expected,`${name} deployed bytecode mismatch`);verified.push({name,address,bytes:actual.length});
}
const sig=s=>execFileSync(path.join(os.homedir(),'.foundry/bin/cast'),['sig',s],{encoding:'utf8'}).trim();
const at=await rpc('eth_blockNumber',[]);
const read=async(a,s)=>rpc('eth_call',[{to:a,data:sig(s)},at]);
assert.equal(Number(BigInt(await read(j.WujiIndex,'GENESIS_HEIGHT()'))),j.genesisHeight);
assert.equal(Number(BigInt(await read(j.WujiIndex,'CONFIRMATIONS()'))),6);
assert.equal(Number(BigInt(await read(j.WujiIndex,'CHECKPOINT_INTERVAL()'))),4320);
assert.equal(BigInt(await read(j.WujiIndex,'UNIT()')),12000000000000n);
if(j.RelayerRewards){
 const addressOf=async(a,s)=>'0x'+(await read(a,s)).slice(-40);
 const bindings=[[j.RelayerRewards,'index()',j.WujiIndex],[j.WujiIndex,'rewards()',j.RelayerRewards],[j.FeeRouter,'rewards()',j.RelayerRewards],[j.WujiVaultFactory,'treasury()',j.FeeRouter],...Object.values(j.vaults).map(v=>[v.address,'treasury()',j.FeeRouter])];
 if(!reserveMode)bindings.push([j.RelayerRewards,'relay()',j.BitcoinRelay],[j.BitcoinRelay,'rewards()',j.RelayerRewards]);
 for(const [a,s,expected] of bindings)assert.equal((await addressOf(a,s)).toLowerCase(),expected.toLowerCase(),s);
 assert.equal(BigInt(await read(j.FeeRouter,'REWARD_BPS()')),reserveMode?10000n:5000n);
 if(reserveMode){
  assert.equal(BigInt(await read(j.RelayerRewards,'BOUNTY_DIVISOR()')),10000n);
  assert.equal(BigInt(await read(j.RelayerRewards,'GENESIS_HEIGHT()')),BigInt(j.genesisHeight));
  assert.equal(await read(j.RelayerRewards,'lastHeight()'),await read(j.WujiIndex,'lastHeight()'));
 }
}
const height=Number(BigInt(await read(j.BitcoinRelay,'bestHeight()'))),hash=await read(j.BitcoinRelay,'bestHash()');
const api=new BitcoinAPI(),source=await api.at(height);assert.equal(hash.slice(2),step(source.header).internalHash);
let timestamps;
if(j.version==='bitcoin-timestamps-v3'){
 assert.equal(BigInt(await read(j.BitcoinRelay,'MAX_FUTURE_BLOCK_TIME()')),7200n);
 assert.equal(BigInt(await read(j.WujiIndex,'MAX_RELAY_AGE()')),10800n);
 assert.equal(('0x'+(await read(j.WujiIndex,'relay()')).slice(-40)).toLowerCase(),j.BitcoinRelay.toLowerCase());
 const times=await Promise.all(Array.from({length:11},async(_,i)=>step((await api.at(height-10+i)).header).timestamp));
 const median=[...times].sort((a,b)=>a-b)[5];
 const data=sig('medianTimePast(bytes32)')+hash.slice(2);
 assert.equal(Number(BigInt(await rpc('eth_call',[{to:j.BitcoinRelay,data},at]))),median);
 timestamps={maxFutureBlockTime:7200,maxRelayAge:10800,medianTimePast:median,relayFresh:BigInt(await read(j.WujiIndex,'relayFresh()'))===1n};
}
const result={verifiedAt:new Date().toISOString(),evmBlock:parseInt(at,16),verified,relayHeight:height,relayHash:source.hash,lastHeight:Number(BigInt(await read(j.WujiIndex,'lastHeight()'))),S_wad:BigInt.asIntN(256,BigInt(await read(j.WujiIndex,'S()'))).toString(),liveFoldPending:height<j.genesisHeight+6,...(timestamps?{timestamps}:{})};
fs.writeFileSync(process.env.VERIFICATION_OUTPUT||'contracts/deployments/bitcoin-verification.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
