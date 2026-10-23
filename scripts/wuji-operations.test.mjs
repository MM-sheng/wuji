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
test('a syntactically valid Bitcoin height older than the deployment cannot clear source alerts',async()=>{
 const f=setup();f.manifest.genesisHeight=900;
 const fetcher=(url,options)=>url.endsWith('/height')?Promise.resolve(new Response('950')):f.fetcher(url,options);
 try{const m=await metricsFor(f.config,f.manifest,{rpc:f.rpc,fetcher});assert.equal(m.sourceError,true);assert.equal(m.externalTip,undefined);}
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

test('failed cost refresh retries after five minutes, preserves historical cost and recovers once',async()=>{
 const f=setup(),file=path.join(f.config.output,'status.json');
 fs.mkdirSync(f.config.output);
 const oldCost={status:'COMPLETE',checkedAt:new Date().toISOString(),gasFeeWei:'123'};
 fs.writeFileSync(file,JSON.stringify({seq:0,cost:oldCost,costError:false}));
 let attempts=0,broken=true;
 const rpc=async(m,p)=>{
  if(m==='eth_getTransactionCount'){
   if(broken)throw Error('RPC eth_getTransactionCount: historical state unavailable https://private.invalid/token');
   return '0x1';
  }return f.rpc(m,p);
 };
 const options={rpc,fetcher:f.fetcher,costReader:async({rpc})=>{
  attempts++;await rpc('eth_getTransactionCount',[worker,'0x20']);
  return {status:'COMPLETE',checkedAt:new Date().toISOString(),gasFeeWei:'456'};
 }};
 try{
  const failed=await run(f.config,options);
  assert.equal(failed.costError,true);assert.deepEqual(failed.cost,oldCost);
  assert.equal(failed.active['cost-coverage'].severity,'warning');
  assert.deepEqual(failed.costFailure,{kind:'execution',rpcMethod:'eth_getTransactionCount',reason:'historical-state-unavailable'});
  assert.ok(!JSON.stringify(failed).includes('private.invalid'));
  await run(f.config,options);assert.equal(attempts,1,'no immediate repeated scan');
  // Simulate the next scheduled sample, still far short of the hourly refresh interval.
  const previous=JSON.parse(fs.readFileSync(file));previous.costAttemptAt=new Date(Date.now()-301000).toISOString();
  fs.writeFileSync(file,JSON.stringify(previous));broken=false;
  const recovered=await run(f.config,options);
  assert.equal(attempts,2);assert.equal(recovered.costError,false);assert.equal(recovered.cost.gasFeeWei,'456');
  assert.equal(recovered.costFailure,undefined);assert.equal(recovered.active['cost-coverage'],undefined);
  assert.equal(recovered.events.filter(e=>e.key==='cost-coverage'&&e.type==='recovered').length,1);
  await run(f.config,options);assert.equal(attempts,2,'success resumes normal hourly interval');
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('cost retry schedule is bounded and error diagnostics never retain raw RPC messages',async()=>{
 const {costRefreshDue,costFailureDetail}=await import('./wuji-operations.mjs');
 const now=10000000,previous={costAttemptAt:new Date(now-299000).toISOString(),costError:true};
 assert.equal(costRefreshDue(previous,3600,now),false);
 assert.equal(costRefreshDue(previous,3600,now+1000),true);
 assert.equal(costRefreshDue({...previous,costError:false},3600,now+1000),false);
 assert.equal(costRefreshDue({},3600,now),true);
 const transport=Object.assign(Error('RPC eth_getBalance failed: HTTP 429 secret'),{rpcReadError:true});
 assert.deepEqual(costFailureDetail(transport,'eth_getBalance'),{kind:'transport',rpcMethod:'eth_getBalance',reason:'rate-limited'});
 assert.equal(costFailureDetail(Error('unknown secret'),'eth_getLogs').reason,null);
 assert.equal(costFailureDetail(Error('cost deadline exceeded'),'eth_getLogs').reason,'deadline');
});
