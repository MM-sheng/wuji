// Fixed historical accounting; public reads only, no signer or production state changes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {costWindow} from '../indexer/operations.mjs';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
import {sel} from '../indexer/zk-challenge.mjs';
import {costFailureDetail} from './wuji-operations.mjs';
const DAY=86400,number=x=>Number(BigInt(x));
export function planWeek(endISO){
 assert.match(endISO,/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/,'explicit timezone required');
 const end=Date.parse(endISO)/1000;assert.ok(Number.isSafeInteger(end),'end must be an ISO timestamp');
 return {schemaVersion:1,secondsPerWindow:DAY,windowCount:7,startTimestamp:end-7*DAY,endTimestamp:end,
  windows:Array.from({length:7},(_,i)=>({id:i+1,startTimestamp:end-(7-i)*DAY,endTimestamp:end-(6-i)*DAY})),
  semantics:'Half-open [start,end); each transaction block belongs to exactly one window.',
  telemetry:'RETROSPECTIVE_CHAIN_ACCOUNTING; historical backlog, RPC outages and human interventions NOT_RECONSTRUCTED'};
}
export function summarizeWeek(plan,windows){
 assert.equal(plan.windows.length,7);assert.equal(windows.length,7,'seven complete windows required');
 assert.equal(plan.startTimestamp,plan.windows[0].startTimestamp);assert.equal(plan.endTimestamp,plan.windows[6].endTimestamp);
 const seen=new Set();let gas=0n,value=0n,credits=0n,allocated=0n,claimed=0n,folded=0,count=0,failed=0;
 const byCategory={};
 for(let i=0;i<7;i++){
  const r=windows[i],w=plan.windows[i];assert.equal(r.status,'COMPLETE');assert.equal(r.chainId,11155111);
  assert.equal(w.endTimestamp-w.startTimestamp,DAY);assert.equal(r.requestedSeconds,DAY);
  assert.equal(r.cutoffTimestamp,w.startTimestamp);assert.equal(r.windowEndExclusiveTimestamp,w.endTimestamp);
  assert.ok(r.endTimestamp<w.endTimestamp);
  assert.equal(r.coveredNonceCount,r.lastNonce-r.firstNonce);assert.equal(r.transactions.length,r.coveredNonceCount);
  let g=0n,v=0n;const cats={};
  for(let j=0;j<r.transactions.length;j++){
   const t=r.transactions[j];assert.equal(t.nonce,r.firstNonce+j);assert.ok(!seen.has(t.hash),'duplicate transaction');seen.add(t.hash);
   assert.ok(t.timestamp>=w.startTimestamp&&t.timestamp<w.endTimestamp,'transaction outside window');
   assert.equal(t.receipt.transactionHash,t.hash);assert.equal(t.receipt.blockHash,t.blockHash);
   assert.equal(t.receipt.blockNumber,t.blockNumber);assert.equal(t.receipt.status,t.status);
   const blobUsed=BigInt(t.receipt.blobGasUsed??'0x0');
   const fee=BigInt(t.receipt.gasUsed)*BigInt(t.receipt.effectiveGasPrice)+(blobUsed===0n?0n:blobUsed*BigInt(t.receipt.blobGasPrice));
   assert.equal(String(fee),t.gasFeeWei);assert.ok(['0x0','0x1'].includes(t.status));
   const executed=t.status==='0x1'?BigInt(t.valueWei):0n;assert.equal(String(executed),t.executedValueWei);
   g+=fee;v+=executed;failed+=t.status==='0x0'?1:0;
   const c=cats[t.category]||={transactions:0,failed:0,gasFeeWei:'0'};c.transactions++;c.failed+=t.status==='0x0'?1:0;c.gasFeeWei=String(BigInt(c.gasFeeWei)+fee);
  }
  assert.deepEqual(cats,r.byCategory);assert.equal(String(g),r.gasFeeWei);assert.equal(String(v),r.outgoingValueWei);
  assert.equal(BigInt(r.nativeBalanceAfterWei)-BigInt(r.nativeBalanceBeforeWei)+g+v,BigInt(r.nativeCreditsInferredWei));
  for(const kind of ['allocated','claimed'])assert.equal(String(r.rewardEvents.filter(e=>e.kind===kind).reduce((s,e)=>s+BigInt(e.amountWei),0n)),r[kind==='allocated'?'rewardsAllocatedWei':'rewardsClaimedWei']);
  assert.equal(r.indexProgress.after-r.indexProgress.before,r.indexProgress.foldedHeights);assert.ok(r.indexProgress.foldedHeights>=0);
  if(i){const prev=windows[i-1];assert.equal(plan.windows[i-1].endTimestamp,w.startTimestamp);assert.equal(prev.endBlock,r.startBlock);assert.equal(prev.endBlockHash,r.startBlockHash);assert.equal(prev.lastNonce,r.firstNonce);assert.equal(prev.nativeBalanceAfterWei,r.nativeBalanceBeforeWei);assert.equal(prev.indexProgress.after,r.indexProgress.before);assert.equal(prev.worker,r.worker);assert.equal(prev.rewardToken,r.rewardToken);}
  gas+=g;value+=v;credits+=BigInt(r.nativeCreditsInferredWei);allocated+=BigInt(r.rewardsAllocatedWei);claimed+=BigInt(r.rewardsClaimedWei);folded+=r.indexProgress.foldedHeights;count+=r.transactions.length;
  for(const [key,item] of Object.entries(cats)){const c=byCategory[key]||={transactions:0,failed:0,gasFeeWei:'0'};c.transactions+=item.transactions;c.failed+=item.failed;c.gasFeeWei=String(BigInt(c.gasFeeWei)+BigInt(item.gasFeeWei));}
 }
 return {status:'COMPLETE',windowCount:7,startTimestamp:plan.startTimestamp,endTimestamp:plan.endTimestamp,chainId:11155111,worker:windows[0].worker,transactions:count,failedTransactions:failed,foldedHeights:folded,gasFeeWei:String(gas),outgoingValueWei:String(value),nativeCreditsInferredWei:String(credits),rewardsAllocatedWei:String(allocated),rewardsClaimedWei:String(claimed),byCategory,telemetry:plan.telemetry,scope:'Keeper outgoing gas and value, inferred native credits, worker WETH allocations/claims. Excludes deployer, user-wallet gas, off-chain host/RPC costs. Not seven days of prospective operational monitoring or economic self-sufficiency.'};
}
const eth=x=>{const n=BigInt(x);return `${n/10n**18n}.${String(n%10n**18n).padStart(18,'0')}`;};
const local=seconds=>new Date((seconds+7*3600)*1000).toISOString().slice(0,16).replace('T',' ');
export function renderWeek(plan,windows,summary){
 return '# 七个不重叠的 24 小时运营成本窗口\n\n时区：Asia/Jakarta（UTC+7）；区间为 [开始,结束)。历史链上补算，逐笔 nonce/收据与规范块核验；不是七天连续监控验收。\n\n'+
 '| 窗口 | 雅加达开始 → 结束 | 笔数 / 失败 | 新折叠高度 | gas（Sepolia ETH） | WETH 分配 / 领取 |\n|---|---|---:|---:|---:|---:|\n'+windows.map((r,i)=>`| ${i+1} | ${local(plan.windows[i].startTimestamp)} → ${local(plan.windows[i].endTimestamp)} | ${r.coveredNonceCount} / ${r.transactions.filter(t=>t.status==='0x0').length} | ${r.indexProgress.foldedHeights} | ${eth(r.gasFeeWei)} | ${eth(r.rewardsAllocatedWei)} / ${eth(r.rewardsClaimedWei)} |`).join('\n')+
 `\n\n合计 ${summary.transactions} 笔，失败 ${summary.failedTransactions} 笔，新折叠 ${summary.foldedHeights} 高度；gas **${eth(summary.gasFeeWei)} Sepolia ETH**。\n\n`+
 `推得原生币净流入 ${eth(summary.nativeCreditsInferredWei)} Sepolia ETH；成功转出 value ${eth(summary.outgoingValueWei)} Sepolia ETH。WETH 分配 ${eth(summary.rewardsAllocatedWei)}，领取 ${eth(summary.rewardsClaimedWei)}，不与 gas 混算。\n\n`+
 '未覆盖：历史外部链头积压、RPC/数据源不可用时长、人工干预，以及部署者、用户钱包和链下服务器费用。缺少同时期连续遥测，以上均为 UNKNOWN，不填零。测试币流入不是营业收入；本表不证明主网预算、第二运营者或经济自养。\n';
}
export function replayWeek(out){
 const plan=JSON.parse(fs.readFileSync(path.join(out,'plan.json')));
 const windows=plan.windows.map(w=>JSON.parse(fs.readFileSync(path.join(out,`window-${String(w.id).padStart(2,'0')}.json`))));
 const summary=summarizeWeek(plan,windows);return {plan,windows,summary};
}
export async function collectWeek(config,out,endISO,{rpc:override}={}){
 fs.mkdirSync(out,{recursive:true});const plan=planWeek(endISO),manifest=JSON.parse(fs.readFileSync(config.manifest));assert.equal(manifest.chainId,11155111);
 const planFile=path.join(out,'plan.json');const identity={...plan,worker:config.worker,index:manifest.WujiHeaderIndex,rewards:manifest.RelayerRewards,token:manifest.accounts.collateral.address};
 if(fs.existsSync(planFile))assert.deepEqual(JSON.parse(fs.readFileSync(planFile)),identity,'resume plan mismatch');else fs.writeFileSync(planFile,JSON.stringify(identity,null,2)+'\n',{flag:'wx'});
 const stateReads=new Set(['eth_getTransactionCount','eth_getBalance','eth_getCode','eth_call']);
 const stateURL=config.costRpc||manifest.rpc,historyURL=config.historyRpc||stateURL;
 if(!override&&stateURL!==historyURL){
  assert.equal(BigInt(await rpcRequest(stateURL,'eth_chainId',[],{attempts:2})),11155111n);
  assert.equal(BigInt(await rpcRequest(historyURL,'eth_chainId',[],{attempts:2})),11155111n);
 }
 const rpc=override||(async(m,p)=>{
  // Pace archival requests; never automatically switch provider after a rejected read.
  if(stateReads.has(m))await new Promise(resolve=>setTimeout(resolve,500));
  return rpcRequest(stateReads.has(m)?stateURL:historyURL,m,p,{attempts:2});
 });const windows=[];
 for(const w of plan.windows){
  const file=path.join(out,`window-${String(w.id).padStart(2,'0')}.json`);let r;
  if(fs.existsSync(file)){r=JSON.parse(fs.readFileSync(file));for(const [n,h] of [[r.startBlock,r.startBlockHash],[r.endBlock,r.endBlockHash]])assert.equal((await rpc('eth_getBlockByNumber',[n,false])).hash,h,'saved window reorganized');}
  else{
   let method=null;const trackedRpc=(m,p)=>{method=m;return rpc(m,p);};
   try{
    r=await costWindow({rpc:trackedRpc,worker:config.worker,index:manifest.WujiHeaderIndex,pools:manifest.accounts.pools.map(p=>p.address.toLowerCase()),rewards:manifest.RelayerRewards,token:manifest.accounts.collateral.address,windowEndTimestamp:w.endTimestamp});
    r.rpcHosts={state:new URL(stateURL).host,history:new URL(historyURL).host};
    const read=async block=>number(await trackedRpc('eth_call',[{to:manifest.WujiHeaderIndex,data:sel('lastHeight()')},block]));
    const before=await read(r.startBlock),after=await read(r.endBlock);r.indexProgress={before,after,foldedHeights:after-before};
    for(const [n,h] of [[r.startBlock,r.startBlockHash],[r.endBlock,r.endBlockHash]])assert.equal((await rpc('eth_getBlockByNumber',[n,false])).hash,h,'window reorganized');
    fs.writeFileSync(file,JSON.stringify(r,null,2)+'\n',{flag:'wx'});
   }catch(error){fs.appendFileSync(path.join(out,'attempts.ndjson'),JSON.stringify({at:new Date().toISOString(),window:w.id,status:'FAILED',...costFailureDetail(error,method)})+'\n');throw Error(`window ${w.id} failed (${costFailureDetail(error,method).reason||'unclassified'}); preserved completed windows and sanitized attempts; manual resume required`);}
  }
  assert.equal(r.worker,config.worker);assert.equal(r.rewardToken,manifest.accounts.collateral.address);
  assert.equal(r.cutoffTimestamp,w.startTimestamp);assert.equal(r.windowEndExclusiveTimestamp,w.endTimestamp);
  windows.push(r);console.log(JSON.stringify({window:w.id,status:r.status,gasFeeWei:r.gasFeeWei,transactions:r.coveredNonceCount}));
 }
 const summary=summarizeWeek(plan,windows);
 fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');fs.writeFileSync(path.join(out,'SUMMARY.md'),renderWeek(plan,windows,summary));return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv[2]==='--summarize'){assert.equal(process.argv.length,4);console.log(JSON.stringify(replayWeek(process.argv[3]).summary));process.exit(0);}
 assert.equal(process.argv.length,5,'usage: node scripts/wuji-cost-week.mjs CONFIG OUTPUT END_ISO | --summarize OUTPUT');console.log(JSON.stringify(await collectWeek(JSON.parse(fs.readFileSync(process.argv[2])),process.argv[3],process.argv[4])));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
