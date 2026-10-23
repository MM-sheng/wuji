// Local read-only monitor. No signer, transactions, shell callbacks or automatic funding/restarts.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
import {readPool} from '../indexer/accounts.mjs';
import {sel} from '../indexer/zk-challenge.mjs';
import {costWindow,assess,transition,DEFAULT_LIMITS} from '../indexer/operations.mjs';

export async function metricsFor(config,manifest,{rpc,fetcher=fetch,now=Date.now()}={}){
 const metrics={observedAt:new Date(now).toISOString()};
 try{
  metrics.logAgeSeconds=Math.max(0,(now-fs.statSync(config.keeperLog).mtimeMs)/1000);
  const text=fs.readFileSync(config.keeperLog,'utf8').slice(-65536),start=text.lastIndexOf('zk keeper on '),lines=text.slice(start<0?0:start).split('\n');
  const waits=lines.map((line,i)=>line.includes('waiting:')?i:-1).filter(i=>i>=0);
  const lastError=lines.reduce((last,line,i)=>/(?:error: RPC|accounts: .*RPC .*failed)/.test(line)?i:last,-1);
  metrics.keeperRpcFailure=lastError>=0&&lastError>=(waits.length>=2?waits.at(-2):0);
 }catch{metrics.logAgeSeconds=null;}
 try{
  assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
  const block=await rpc('eth_getBlockByNumber',['latest',false]);
  assert.ok(block?.hash&&Math.abs(now/1000-Number(BigInt(block.timestamp)))<=120,'stale RPC');
  const read=(to,data)=>rpc('eth_call',[{to,data},block.number]);
  const view=async(to,sig,args='')=>BigInt(await read(to,sel(sig)+args));
  const token=manifest.accounts.collateral.address;
  const arg=token.slice(2).padStart(64,'0');
  const [balance,height,seenTime,confirmations,s,hash,reserve,allocated,reserveBalance,frozen]=await Promise.all([
   rpc('eth_getBalance',[config.worker,block.number]),view(manifest.WujiHeaderIndex,'lastHeight()'),
   view(manifest.WujiHeaderIndex,'seenTime()'),view(manifest.WujiHeaderIndex,'CONFIRMATIONS()'),
   read(manifest.WujiHeaderIndex,sel('S()')),read(manifest.WujiHeaderIndex,sel('lastHash()')),
   view(manifest.RelayerRewards,'reserve(address)',arg),view(manifest.RelayerRewards,'allocated(address)',arg),
   view(token,'balanceOf(address)',manifest.RelayerRewards.slice(2).padStart(64,'0')),
   view(manifest.WujiHeaderIndex,'frozen()'),
  ]);
  assert.equal(confirmations,100n);
  const pools=await Promise.all(manifest.accounts.pools.map(async({address})=>{
   try{return await readPool(read,address.toLowerCase());}catch{return {address:address.toLowerCase(),error:true};}
  }));
  assert.equal((await rpc('eth_getBlockByNumber',[block.number,false])).hash,block.hash);
  Object.assign(metrics,{evmBlock:block.number,evmBlockHash:block.hash,balanceWei:String(BigInt(balance)),indexHeight:Number(height),confirmations:Number(confirmations),seenAgeSeconds:Math.max(0,now/1000-Number(seenTime)),S:s,lastHash:hash,reserveAvailableWei:String(reserve),reserveAllocatedWei:String(allocated),reserveTokenBalanceWei:String(reserveBalance),reserveDeficit:reserveBalance<reserve+allocated,indexFrozen:frozen===1n,pools});
 }catch{metrics.rpcError=true;}
 const sourceResults=await Promise.allSettled((config.bitcoinSources||['https://mempool.space/api','https://blockstream.info/api']).map(async base=>{
  const response=await fetcher(base+'/blocks/tip/height',{signal:AbortSignal.timeout(15000),cache:'no-store'});
  assert.ok(response.ok);const raw=(await response.text()).trim();assert.match(raw,/^[0-9]{1,9}$/);const tip=Number(raw);
  assert.ok(tip>=Math.max(manifest.genesisHeight||0,metrics.indexHeight||0),'Bitcoin source predates verified history');return tip;
 }));
 const tips=sourceResults.filter(x=>x.status==='fulfilled').map(x=>x.value);
 metrics.sourceError=tips.length!==2||(tips.length===2&&Math.abs(tips[0]-tips[1])>2);
 if(tips.length&&Math.max(...tips)>=metrics.indexHeight)metrics.externalTip=Math.max(...tips);
 metrics.sourceTips=tips;
 try{
  const response=await fetcher(config.url+'/head',{signal:AbortSignal.timeout(15000)});assert.ok(response.ok);
  const h=await response.json();assert.equal(h.chain.contract.toLowerCase(),manifest.WujiHeaderIndex.toLowerCase());
  const observed=Number(h.chain.observedAt),latest=Number(BigInt(metrics.evmBlock));
  assert.ok(Number.isSafeInteger(observed)&&Math.abs(latest-observed)<=60,'indexer observation stale');
  metrics.indexerError=!!h.err||!!h.halted;
  if(h.chain.lastHeight===metrics.indexHeight){
   metrics.indexerReconciliationPending=false;
   // Compare signed S without floating-point conversions.
   const onchain=BigInt(metrics.S),signed=onchain>=(1n<<255n)?onchain-(1n<<256n):onchain;
   metrics.divergence=BigInt(h.chain.indexer_S_wad)!==signed||h.chain.indexerHash.toLowerCase()!==metrics.lastHash.toLowerCase();
  }else metrics.indexerReconciliationPending=true;
 }catch{metrics.indexerError=true;}
 return metrics;
}

// Successful windows refresh hourly; a failed read is retried on the next five-minute sample.
// The old complete window remains historical evidence, never a replacement for a failed refresh.
export function costRefreshDue(previous,intervalSeconds,now=Date.now()){
 const interval=previous.costError===true?Math.min(intervalSeconds,300):intervalSeconds;
 return !previous.costAttemptAt||now-Date.parse(previous.costAttemptAt)>=interval*1000;
}
export function costFailureDetail(error,method){
 const reason=/cost deadline exceeded/.test(error.message)?'deadline':
  /missing trie node|historical state|state is not available|state unavailable|no state available/i.test(error.message)?'historical-state-unavailable':
  /rate limit|too many requests|HTTP 429/i.test(error.message)?'rate-limited':
  /timeout|timed out/i.test(error.message)?'timeout':null;
 return {kind:error.rpcReadError?'transport':error.code==='ERR_ASSERTION'?'validation':'execution',rpcMethod:method,reason};
}
export async function run(config,{refreshCost=false,rpc:rpcOverride,fetcher=fetch,costReader=costWindow}={}){
 const manifest=JSON.parse(fs.readFileSync(config.manifest));assert.equal(manifest.chainId,11155111);
 assert.match(config.worker,/^0x[0-9a-f]{40}$/i);assert.ok(Number.isFinite(config.costEverySeconds)&&config.costEverySeconds>=300);
 const limits={...DEFAULT_LIMITS,...config.limits};
 assert.ok(BigInt(limits.balanceWarnWei)>BigInt(limits.balanceCriticalWei)&&BigInt(limits.balanceCriticalWei)>0n);
 for(const [warn,critical] of [['backlogWarn','backlogCritical'],['seenWarnSeconds','seenCriticalSeconds'],['readyWarnSeconds','readyCriticalSeconds'],['logWarnSeconds','logCriticalSeconds']])assert.ok(Number.isSafeInteger(limits[warn])&&Number.isSafeInteger(limits[critical])&&limits[warn]>0&&limits[critical]>=limits[warn]);
 fs.mkdirSync(config.output,{recursive:true});const lock=path.join(config.output,'monitor.lock');
 try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});}catch(error){
  if(error.code!=='EEXIST')throw error;
  const pid=JSON.parse(fs.readFileSync(lock)).pid;assert.ok(Number.isSafeInteger(pid)&&pid>0,'invalid lock');
  try{process.kill(pid,0);throw Error('monitor already running');}catch(e){if(e.code!=='ESRCH')throw e;}
  fs.renameSync(lock,lock+'.stale-'+Date.now());fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});
 }
 try{
  const file=path.join(config.output,'status.json');const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
  if(previous.costAttemptAt)assert.ok(Number.isFinite(Date.parse(previous.costAttemptAt)),'invalid cost timestamp');
  const rpc=rpcOverride||((m,p)=>rpcRequest(manifest.rpc,m,p,{attempts:2}));
  const metrics=await metricsFor(config,manifest,{rpc,fetcher});let cost=previous.cost,costError=previous.costError;
  if(!metrics.rpcError&&(refreshCost||costRefreshDue(previous,config.costEverySeconds))){
   previous.costAttemptAt=new Date().toISOString();const deadline=Date.now()+210000;let costMethod=null;
   try{cost=await costReader({rpc:(m,p)=>{costMethod=m;assert.ok(Date.now()<deadline,'cost deadline exceeded');return rpc(m,p);},worker:config.worker,index:manifest.WujiHeaderIndex,pools:manifest.accounts.pools.map(p=>p.address.toLowerCase()),rewards:manifest.RelayerRewards,token:manifest.accounts.collateral.address});costError=false;}
  catch(error){costError=true;previous.costFailure=costFailureDetail(error,costMethod);}
  }
  metrics.costError=costError!==false||!cost||Date.now()-Date.parse(cost.checkedAt)>7200000;
  const result=transition(previous,assess(metrics,previous,limits));
  const report={schemaVersion:1,monitorSource:config.sourceCommit,...result.state,checkedAt:new Date().toISOString(),metrics,limits,cost,costError:metrics.costError,costFailure:metrics.costError?previous.costFailure:undefined,costAttemptAt:previous.costAttemptAt};
  fs.writeFileSync(file+'.tmp',JSON.stringify(report,null,2)+'\n');fs.renameSync(file+'.tmp',file);
  for(const event of result.events)console.log(JSON.stringify(event));
  console.log(JSON.stringify({at:report.checkedAt,status:'observed',active:Object.keys(report.active),costComplete:!report.costError}));
  return report;
 }finally{fs.unlinkSync(lock);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file=process.argv[2]||process.env.OPERATIONS_CONFIG;assert.ok(file,'usage: node scripts/wuji-operations.mjs CONFIG.json');
 try{await run(JSON.parse(fs.readFileSync(file)),{refreshCost:process.argv.includes('--refresh-cost')});}catch{console.error('WUJI operations monitor failed; inspect local configuration or report freshness');process.exitCode=1;}
}
