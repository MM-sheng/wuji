import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {run,metricsFor} from './wuji-operations.mjs';import {sel} from '../indexer/zk-challenge.mjs';
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const worker='0x'+'11'.repeat(20),index='0x'+'22'.repeat(20),pool='0x'+'33'.repeat(20),reserve='0x'+'44'.repeat(20),token='0x'+'55'.repeat(20),indexHash=word(123);
function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-operations-')),keeperLog=path.join(dir,'keeper.log');fs.writeFileSync(keeperLog,'00:00:00 waiting: 104 headers past 1000\n');
 const manifest={chainId:11155111,rpc:'http://rpc.invalid',WujiHeaderIndex:index,RelayerRewards:reserve,accounts:{collateral:{address:token},pools:[{address:pool}]}};
 const manifestFile=path.join(dir,'manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 const config={manifest:manifestFile,worker,keeperLog,output:path.join(dir,'output'),url:'http://indexer.invalid',costEverySeconds:3600};
 const state={balance:1n,offline:false};
 const rpc=async(m,p)=>{
  if(state.offline)throw Error('network unavailable');
  if(m==='eth_chainId')return '0xaa36a7';
  if(m==='eth_getBlockByNumber')return {number:'0x20',hash:word(32),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
  if(m==='eth_getBalance')return '0x'+state.balance.toString(16);
  if(m==='eth_call'){
   const {to,data}=p[0],s=data.slice(0,10);
   if(to===index){if(s===sel('lastHeight()'))return word(1000);if(s===sel('CONFIRMATIONS()'))return word(100);if(s===sel('seenTime()'))return word(Math.floor(Date.now()/1000)-60);if(s===sel('lastHash()'))return indexHash;return word(0);}
   if(to===reserve)return word(s===sel('reserve(address)')?100:0);
   if(to===token)return word(100);
   if(s==='0x38d52e0f')return word(token);if(s==='0x2986c0e5')return word(index);
   if(s==='0xa932492f')return word(11500000000000000000n);if(s==='0xa0dc2758')return word(6);if(s==='0x61b8ce8c')return word(1);
   return word(0);
  }
  throw Error('unexpected '+m);
 };
 const head={chain:{contract:index,observedAt:32,lastHeight:1000,indexer_S_wad:'0',indexerHash:indexHash}};
 const fetcher=async(url,options)=>url==='http://rpc.invalid'?new Response(JSON.stringify({result:await rpc(JSON.parse(options.body).method,JSON.parse(options.body).params)})):url.endsWith('/head')?new Response(JSON.stringify(head)):new Response('1135');
 return {dir,config,manifest,state,rpc,fetcher};
}
test('real metrics path keeps pinned reads and reports a keeper RPC failure independently of log activity',async()=>{
 const f=setup();fs.writeFileSync(f.config.keeperLog,'00:00:00 waiting: 1\n00:01:00 accounts: 0x3333 RPC eth_call failed after 3 attempt(s): transport ECONNRESET\n');
 try{const m=await metricsFor(f.config,f.manifest,{rpc:f.rpc,fetcher:f.fetcher});assert.equal(m.rpcError,undefined);assert.equal(m.divergence,false);assert.equal(m.keeperRpcFailure,true);assert.equal(m.pools[0].pendingEpochs,0);assert.equal(m.externalTip,1135);}
 finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('CLI persistence deduplicates across restarts and emits one recovery; concurrent lock cannot be stolen',async()=>{
 const f=setup(),original=globalThis.fetch;globalThis.fetch=f.fetcher;
 fs.mkdirSync(f.config.output);fs.writeFileSync(path.join(f.config.output,'status.json'),JSON.stringify({seq:0,costAttemptAt:new Date().toISOString(),cost:{checkedAt:new Date().toISOString()},costError:false}));
 try{
  const first=await run(f.config);assert.equal(first.seq,1);assert.equal(first.active.balance.severity,'critical');
  assert.equal((await run(f.config)).seq,1);
  f.state.balance=100000000000000000n;const recovered=await run(f.config);assert.equal(recovered.seq,2);assert.equal(recovered.events.at(-1).type,'recovered');
  fs.writeFileSync(path.join(f.config.output,'monitor.lock'),JSON.stringify({pid:process.pid}));await assert.rejects(run(f.config),/already running/);
  assert.ok(fs.existsSync(path.join(f.config.output,'monitor.lock')),'another process lock must remain untouched');
 }finally{globalThis.fetch=original;fs.rmSync(f.dir,{recursive:true,force:true});}
});
