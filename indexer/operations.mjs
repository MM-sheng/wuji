// Read-only operator accounting. All values are raw integers; ETH and WETH never share a total.
import assert from 'node:assert/strict';
export const BOUNTY='0x49a586e3ba77e5dcc1470780153a1d842f542f0bb3a4e8107c7491871c45fe99';
export const CLAIMED='0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683';
const hex=n=>'0x'+BigInt(n).toString(16),num=x=>Number(BigInt(x));
const addr=a=>'0x'+a.toLowerCase().slice(2).padStart(64,'0');
const word=(data,i)=>BigInt('0x'+data.slice(2+64*i,66+64*i));

export async function costWindow({rpc,worker,index,pools,rewards,token,seconds=86400,maxTransactions=200,now=Date.now()}){
 assert.ok(Number.isInteger(seconds)&&seconds>0&&seconds<=604800);
 assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
 const end=await rpc('eth_getBlockByNumber',['finalized',false]);assert.ok(end?.hash,'finalized block unavailable');
 assert.ok(now/1000-num(end.timestamp)>=-120&&now/1000-num(end.timestamp)<3600,'finalized view stale');
 const last=num(end.number),cutoff=num(end.timestamp)-seconds,blocks=new Map([[last,end]]),nonces=new Map();
 const block=async n=>{if(!blocks.has(n))blocks.set(n,await rpc('eth_getBlockByNumber',[hex(n),false]));const b=blocks.get(n);assert.ok(b?.hash,'missing canonical block');return b;};
 // Boundary is the last block strictly before cutoff: every included transaction is in the requested window.
 let lo=0,hi=last;
 while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(num((await block(mid)).timestamp)<cutoff)lo=mid;else hi=mid-1;}
 const start=await block(lo),first=lo;
 const nonce=async n=>{if(!nonces.has(n))nonces.set(n,num(await rpc('eth_getTransactionCount',[worker,hex(n)])));const value=nonces.get(n);assert.ok(Number.isSafeInteger(value)&&value>=0,'unsafe nonce');return value;};
 const firstNonce=await nonce(first),lastNonce=await nonce(last);assert.ok(lastNonce>=firstNonce&&lastNonce-firstNonce<=maxTransactions,'nonce coverage exceeds bounded scan');
 const transactions=[];const fullBlocks=new Map();
 for(let n=firstNonce;n<lastNonce;n++){
  let a=first+1,b=last;
  while(a<b){const mid=Math.floor((a+b)/2);if(await nonce(mid)>n)b=mid;else a=mid+1;}
  if(!fullBlocks.has(a))fullBlocks.set(a,await rpc('eth_getBlockByNumber',[hex(a),true]));
  const full=fullBlocks.get(a),tx=full?.transactions?.find(t=>t.from.toLowerCase()===worker.toLowerCase()&&num(t.nonce)===n);
  assert.ok(tx,`nonce ${n} not attributable to an outgoing transaction; refuse incomplete accounting`);
  const receipt=await rpc('eth_getTransactionReceipt',[tx.hash]);assert.ok(receipt,'receipt unavailable');
  assert.equal(receipt.blockHash,full.hash);assert.equal(receipt.blockNumber,full.number);
  assert.equal(tx.blockHash,full.hash);assert.equal(receipt.transactionHash,tx.hash);
  assert.ok(['0x0','0x1'].includes(receipt.status),'unknown receipt status');
  const blob=receipt.blobGasUsed?BigInt(receipt.blobGasUsed)*BigInt(receipt.blobGasPrice):0n;
  const cost=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)+blob;
  const to=tx.to?.toLowerCase();const category=to===index.toLowerCase()?'index':pools.includes(to)?'pool-maintenance':to===rewards.toLowerCase()?'reward-claim':'other';
  transactions.push({hash:tx.hash,nonce:n,blockNumber:full.number,blockHash:full.hash,timestamp:num(full.timestamp),to:tx.to,selector:tx.input.slice(0,10),category,status:receipt.status,gasUsed:String(BigInt(receipt.gasUsed)),effectiveGasPriceWei:String(BigInt(receipt.effectiveGasPrice)),blobFeeWei:String(blob),gasFeeWei:String(cost),valueWei:String(BigInt(tx.value)),executedValueWei:receipt.status==='0x1'?String(BigInt(tx.value)):'0',receipt});
 }
 const [before,after,codeBefore,codeAfter]=await Promise.all([
  rpc('eth_getBalance',[worker,start.number]),rpc('eth_getBalance',[worker,end.number]),
  rpc('eth_getCode',[worker,start.number]),rpc('eth_getCode',[worker,end.number]),
 ]);
 assert.equal(codeBefore,'0x','balance bridge requires an ordinary EOA');assert.equal(codeAfter,'0x','balance bridge requires an ordinary EOA');
 const gas=transactions.reduce((s,t)=>s+BigInt(t.gasFeeWei),0n),value=transactions.reduce((s,t)=>s+BigInt(t.executedValueWei),0n);
 const nativeCredits=BigInt(after)-BigInt(before)+gas+value;assert.ok(nativeCredits>=0n,'unexplained balance movement');
 const events=[];
 // Bounded provider ranges. RPC failure cannot silently become zero bounty income.
 for(let from=first+1;from<=last;from+=1000){
  const logs=await rpc('eth_getLogs',[{address:rewards,fromBlock:hex(from),toBlock:hex(Math.min(last,from+999)),topics:[[BOUNTY,CLAIMED],addr(token),addr(worker)]}]);
  for(const log of logs){assert.equal(log.removed,false);assert.equal(log.address.toLowerCase(),rewards.toLowerCase());
   assert.equal(log.topics[1],addr(token));assert.equal(log.topics[2],addr(worker));
   assert.equal((await block(num(log.blockNumber))).hash,log.blockHash);
   events.push({kind:log.topics[0]===BOUNTY?'allocated':'claimed',amountWei:String(word(log.data,log.topics[0]===BOUNTY?2:0)),transactionHash:log.transactionHash,logIndex:log.logIndex,blockHash:log.blockHash});
  }
 }
 const sumEvent=kind=>events.filter(e=>e.kind===kind).reduce((s,e)=>s+BigInt(e.amountWei),0n);
 const byCategory={};for(const tx of transactions){const item=byCategory[tx.category]||={transactions:0,failed:0,gasFeeWei:'0'};item.transactions++;item.failed+=tx.status==='0x0'?1:0;item.gasFeeWei=String(BigInt(item.gasFeeWei)+BigInt(tx.gasFeeWei));}
 assert.equal((await rpc('eth_getBlockByNumber',[start.number,false])).hash,start.hash,'start reorganized');
 for(const [n,full] of fullBlocks)assert.equal((await rpc('eth_getBlockByNumber',[hex(n),false])).hash,full.hash,'transaction block reorganized');
 assert.equal((await rpc('eth_getBlockByNumber',[end.number,false])).hash,end.hash,'end reorganized');
 return {status:'COMPLETE',checkedAt:new Date().toISOString(),chainId:11155111,worker,requestedSeconds:seconds,cutoffTimestamp:cutoff,startBlock:start.number,startBlockHash:start.hash,endBlock:end.number,endBlockHash:end.hash,endTimestamp:num(end.timestamp),firstNonce,lastNonce,coveredNonceCount:transactions.length,transactions,byCategory,gasFeeWei:String(gas),outgoingValueWei:String(value),nativeBalanceBeforeWei:String(BigInt(before)),nativeBalanceAfterWei:String(BigInt(after)),nativeCreditsInferredWei:String(nativeCredits),rewardToken:token,rewardsAllocatedWei:String(sumEvent('allocated')),rewardsClaimedWei:String(sumEvent('claimed')),rewardEvents:events,scope:'Finalized rolling window; all outgoing nonce slots resolved or the report fails. Failed transactions cost gas too. Native credits inferred from the balance bridge, not individually attributed faucet receipts. WETH allocations and claims are separate; claims may pay earlier allocations. No ETH/WETH netting, fiat estimate, runway guarantee or signature.'};
}

export const DEFAULT_LIMITS={balanceWarnWei:'5000000000000000',balanceCriticalWei:'1000000000000000',backlogWarn:72,backlogCritical:144,seenWarnSeconds:43200,seenCriticalSeconds:86400,readyWarnSeconds:1800,readyCriticalSeconds:7200,logWarnSeconds:900,logCriticalSeconds:1800};
export function assess(metrics,previous={},limits=DEFAULT_LIMITS,now=Date.now()){
 const conditions={},ready={...(previous.ready||{})};
 const check=(key,severity,message)=>conditions[key]={severity,message};
 const level=(n,w,c)=>n>=c?'critical':n>=w?'warning':null;
 check('rpc',metrics.rpcError?'critical':null,metrics.rpcError?'Sepolia RPC 读取失败，相关状态未知':'Sepolia RPC 已恢复');
 if(!metrics.rpcError){
  const balance=BigInt(metrics.balanceWei),severity=balance<BigInt(limits.balanceCriticalWei)?'critical':balance<BigInt(limits.balanceWarnWei)?'warning':null;
  check('balance',severity,`keeper 余额 ${metrics.balanceWei} wei（Sepolia ETH）`);
  check('reserve',BigInt(metrics.reserveAvailableWei)===0n?'warning':null,'WETH 可用运营赏金储备为零');
  check('reserve-deficit',metrics.reserveDeficit?'critical':null,'WETH 储备实际余额低于已记账储备和已分配赏金');
  check('index-frozen',metrics.indexFrozen?'critical':null,'指数已经封存，常规推进停止');
  check('seen-age',level(metrics.seenAgeSeconds,limits.seenWarnSeconds,limits.seenCriticalSeconds),`链上最新验证头年龄 ${metrics.seenAgeSeconds} 秒`);
  if(Number.isInteger(metrics.externalTip)){
   const backlog=Math.max(0,metrics.externalTip-metrics.indexHeight-metrics.confirmations);
   check('fold-backlog',level(backlog,limits.backlogWarn,limits.backlogCritical),`扣除 ${metrics.confirmations} 确认后的可折叠积压 ${backlog} 高度`);
  }
  for(const pool of metrics.pools||[]){
   check('pool-read:'+pool.address,pool.error?'critical':null,`池 ${pool.address} 状态读取${pool.error?'失败':'恢复'}`);
   if(pool.error)continue;
   check('pool-insolvent:'+pool.address,pool.insolvent?'critical':null,`池 ${pool.address} 自动资不抵债终止状态`);
   const key=pool.address+':'+pool.nextEpoch;
   if(pool.nextEpochReady){ready[pool.address]=ready[pool.address]?.key===key?ready[pool.address]:{key,since:now};
    const seconds=(now-ready[pool.address].since)/1000;
    check('pool-ready:'+pool.address,level(seconds,limits.readyWarnSeconds,limits.readyCriticalSeconds),`池 ${pool.address} 已可处理 ${Math.floor(seconds)} 秒`);
   }else{delete ready[pool.address];check('pool-ready:'+pool.address,null,'池待处理积压已清除');}
  }
 }
 check('bitcoin-source',metrics.sourceError?'warning':null,'独立 Bitcoin 链头来源不可用或分歧');
 check('indexer',metrics.indexerError?'critical':null,'本地索引器不可用或观测过时');
 if(metrics.indexerReconciliationPending!==undefined)check('indexer-reconciliation',metrics.indexerReconciliationPending?'warning':null,'索引器和合约观测高度不同，暂不可比较整数 S');
 if(metrics.divergence!==undefined)check('divergence',metrics.divergence?'critical':null,'同高度链上与索引器整数 S / 哈希不一致');
 const age=metrics.logAgeSeconds;
 check('keeper-log',age===null?'critical':level(age,limits.logWarnSeconds,limits.logCriticalSeconds),age===null?'keeper 日志缺失':`keeper 日志 ${Math.floor(age)} 秒未更新`);
 if(metrics.keeperRpcFailure!==undefined)check('keeper-rpc',metrics.keeperRpcFailure?'warning':null,'keeper 最近周期有 RPC 错误；连续两个正常周期后恢复');
 if(metrics.costError!==undefined)check('cost-coverage',metrics.costError?'warning':null,'24 小时成本窗口不完整，禁止按零成本展示');
 return {conditions,ready};
}

export function transition(previous,{conditions,ready},now=Date.now()){
 const active={...(previous.active||{})},events=[];let seq=previous.seq||0;
 for(const [key,item] of Object.entries(conditions)){
  const old=active[key];
  if(!item.severity){if(old){events.push({seq:++seq,at:new Date(now).toISOString(),key,type:'recovered',severity:old.severity,message:item.message});delete active[key];}continue;}
  if(!old||old.severity!==item.severity)events.push({seq:++seq,at:new Date(now).toISOString(),key,type:old?'changed':'opened',...item});
  active[key]={...item,since:old?.since||new Date(now).toISOString()};
 }
 // Missing measurements do not recover older balance/backlog/solvency conditions.
 return {state:{seq,active,ready,events:[...(previous.events||[]),...events].slice(-500)},events};
}
