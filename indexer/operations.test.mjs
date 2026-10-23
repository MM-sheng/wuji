import test from 'node:test';import assert from 'node:assert/strict';
import {costWindow,assess,transition,BOUNTY,CLAIMED,DEFAULT_LIMITS} from './operations.mjs';
const worker='0x'+'11'.repeat(20),index='0x'+'22'.repeat(20),pool='0x'+'33'.repeat(20),rewards='0x'+'44'.repeat(20),token='0x'+'55'.repeat(20);
const hex=n=>'0x'+n.toString(16),hash=n=>'0x'+n.toString(16).padStart(64,'0'),addr=a=>'0x'+a.slice(2).padStart(64,'0'),word=n=>n.toString(16).padStart(64,'0');
function fixture(){
 const transactions=[{nonce:'0x1',hash:hash(106),from:worker,to:index,blockHash:hash(6),input:'0x12345678',value:'0x5'},
  {nonce:'0x2',hash:hash(108),from:worker,to:pool,blockHash:hash(8),input:'0x12345678',value:'0x3e7'}];
 const receipts=transactions.map((tx,i)=>({transactionHash:tx.hash,blockNumber:hex(i?8:6),blockHash:tx.blockHash,status:i?'0x0':'0x1',gasUsed:hex(i?10:21),effectiveGasPrice:hex(i?1:2)}));
 const events=[{address:rewards,topics:[BOUNTY,addr(token),addr(worker)],data:'0x'+word(1)+word(2)+word(7),blockNumber:'0x7',blockHash:hash(7),removed:false,transactionHash:hash(107),logIndex:'0x0'},
 {address:rewards,topics:[CLAIMED,addr(token),addr(worker)],data:'0x'+word(5),blockNumber:'0x9',blockHash:hash(9),removed:false,transactionHash:hash(109),logIndex:'0x0'}];
 const calls=[];
 const rpc=async(method,params)=>{
  calls.push([method,params]);
  if(method==='eth_chainId')return '0xaa36a7';
  if(method==='eth_getBlockByNumber'){const n=params[0]==='finalized'?10:Number(BigInt(params[0]));return {number:hex(n),hash:hash(n),timestamp:hex(1000+n*60),transactions:params[1]?transactions.filter(t=>t.blockHash===hash(n)):[]};}
  if(method==='eth_getTransactionCount'){const n=Number(BigInt(params[1]));return hex(n>=8?3:n>=6?2:n>=2?1:0);}
  if(method==='eth_getTransactionReceipt')return receipts.find(r=>r.transactionHash===params[0]);
  if(method==='eth_getBalance')return params[1]==='0x4'?'0x64':'0x69';
  if(method==='eth_getCode')return '0x';if(method==='eth_getLogs')return events;
  throw Error('Unexpected RPC '+method);
 };
 return {rpc,transactions,receipts,events,calls};
}
const args=f=>({rpc:f.rpc,worker,index,pools:[pool],rewards,token,seconds:300,now:1600000});
test('complete nonce scan includes failed gas, excludes failed ETH value, and separates bounty allocations/claims',async()=>{
 const f=fixture(),r=await costWindow(args(f));
 assert.equal(r.startBlock,'0x4');assert.equal(r.coveredNonceCount,2);assert.equal(r.gasFeeWei,'52');assert.equal(r.outgoingValueWei,'5');assert.equal(r.nativeCreditsInferredWei,'62');
 assert.equal(r.rewardsAllocatedWei,'7');assert.equal(r.rewardsClaimedWei,'5');assert.equal(r.transactions[1].status,'0x0');
 assert.ok(f.calls.every(([m])=>!m.includes('send')&&!m.includes('sign')));
});
test('missing nonce transaction, missing receipt and incomplete log coverage cannot become a complete report',async()=>{
 for(const broken of ['transaction','receipt','logs']){
  const f=fixture(),base=f.rpc;
  f.rpc=async(m,p)=>{
   if(broken==='transaction'&&m==='eth_getBlockByNumber'&&p[1])return {...await base(m,p),transactions:[]};
   if(broken==='receipt'&&m==='eth_getTransactionReceipt')return null;
   if(broken==='logs'&&m==='eth_getLogs')throw Error('source unavailable');return base(m,p);
  };
  await assert.rejects(costWindow(args(f)));
 }
});
test('chain mismatch, reorganization, delegated worker, stale finality and excessive scan all fail closed',async()=>{
 for(const broken of ['chain','reorg','code','stale','limit']){
  const f=fixture(),base=f.rpc;
  f.rpc=async(m,p)=>{
   if(broken==='chain'&&m==='eth_chainId')return '0x1';
   if(broken==='code'&&m==='eth_getCode')return '0xef0100';
   if(broken==='reorg'&&m==='eth_getBlockByNumber'&&p[0]==='0x8'&&!p[1])return {...await base(m,p),hash:hash(999)};
   return base(m,p);
  };
  await assert.rejects(costWindow({...args(f),...(broken==='stale'?{now:999999999}:{}),...(broken==='limit'?{maxTransactions:1}:{})}));
 }
});
const healthy=()=>({balanceWei:'100000000000000000',reserveAvailableWei:'100',seenAgeSeconds:60,confirmations:100,indexHeight:1000,externalTip:1135,sourceError:false,indexerError:false,divergence:false,logAgeSeconds:10,keeperRpcFailure:false,costError:false,pools:[]});
test('100 confirmations and batching do not cause a false lag alert',()=>{
 const r=assess(healthy());assert.ok(Object.values(r.conditions).every(c=>!c.severity));
 const warn=assess({...healthy(),externalTip:1172});assert.equal(warn.conditions['fold-backlog'].severity,'warning');
 const critical=assess({...healthy(),externalTip:1244});assert.equal(critical.conditions['fold-backlog'].severity,'critical');
});
test('durable transitions notify once, escalate once and recover once, without per-value spam',()=>{
 let r=transition({},assess({...healthy(),balanceWei:'2000000000000000'}),1000);assert.equal(r.events.length,1);assert.equal(r.events[0].type,'opened');
 r=transition(JSON.parse(JSON.stringify(r.state)),assess({...healthy(),balanceWei:'1900000000000000'}),2000);assert.equal(r.events.length,0);
 r=transition(r.state,assess({...healthy(),balanceWei:'1'}),3000);assert.equal(r.events.length,1);assert.equal(r.events[0].severity,'critical');
 r=transition(r.state,assess(healthy()),4000);assert.equal(r.events.length,1);assert.equal(r.events[0].type,'recovered');
 r=transition(r.state,assess(healthy()),5000);assert.equal(r.events.length,0);
});
test('unavailable RPC does not silently recover a low balance or an existing backlog',()=>{
 const initial=transition({},assess({...healthy(),balanceWei:'1',externalTip:1300}),1000);
 const outage=transition(initial.state,assess({rpcError:true,sourceError:true,indexerError:true,logAgeSeconds:10}),2000);
 assert.equal(outage.state.active.balance.severity,'critical');assert.ok(outage.state.active['fold-backlog']);
 assert.ok(!outage.events.some(e=>e.type==='recovered'));
});
test('ready-epoch timer persists across polls, resets for a new epoch, and does not clear on read failure',()=>{
 const pending={address:pool,nextEpoch:100,nextEpochReady:true};let r=assess({...healthy(),pools:[pending]},{},DEFAULT_LIMITS,1000);
 r=assess({...healthy(),pools:[pending]},{ready:r.ready},DEFAULT_LIMITS,1900000);assert.equal(r.conditions['pool-ready:'+pool].severity,'warning');
 const failed=assess({...healthy(),pools:[{address:pool,error:true}]},{ready:r.ready},DEFAULT_LIMITS,2000000);assert.equal(failed.ready[pool].since,1000);assert.equal(failed.conditions['pool-ready:'+pool],undefined);
 const next=assess({...healthy(),pools:[{...pending,nextEpoch:101}]},{ready:r.ready},DEFAULT_LIMITS,2000000);assert.equal(next.conditions['pool-ready:'+pool].severity,null);
});
test('missing logs, frozen index, reserve deficits and insolvent pools are visible',()=>{
 const r=assess({...healthy(),logAgeSeconds:null,indexFrozen:true,reserveDeficit:true,pools:[{address:pool,insolvent:true,nextEpochReady:false}]});
 for(const key of ['keeper-log','index-frozen','reserve-deficit','pool-insolvent:'+pool])assert.equal(r.conditions[key].severity,'critical');
});

test('adjacent historical windows exclude their end timestamp and count each nonce exactly once',async()=>{
 const f=fixture(),base=f.rpc;
 f.rpc=async(m,p)=>m==='eth_getLogs'?(await base(m,p)).filter(l=>BigInt(l.blockNumber)>=BigInt(p[0].fromBlock)&&BigInt(l.blockNumber)<=BigInt(p[0].toBlock)):base(m,p);
 const a=await costWindow({...args(f),seconds:180,windowEndTimestamp:1420});
 const b=await costWindow({...args(f),seconds:180,windowEndTimestamp:1600});
 assert.equal(a.cutoffTimestamp,1240);assert.equal(a.windowEndExclusiveTimestamp,1420);
 assert.equal(a.endBlock,b.startBlock);assert.equal(a.lastNonce,b.firstNonce);
 assert.deepEqual(a.transactions.map(t=>t.nonce),[1]);assert.deepEqual(b.transactions.map(t=>t.nonce),[2]);
 assert.equal(BigInt(a.gasFeeWei)+BigInt(b.gasFeeWei),52n);
 // Block 8 is exactly at the exclusive end and must not enter the first window.
 const exact=await costWindow({...args(f),seconds:180,windowEndTimestamp:1480});
 assert.equal(exact.endBlock,'0x7');assert.deepEqual(exact.transactions.map(t=>t.nonce),[1]);
});
test('historical windows reject future/unfinalized boundaries and chain history gaps',async()=>{
 const f=fixture();
 for(const windowEndTimestamp of [1601,NaN,1])await assert.rejects(costWindow({...args(f),windowEndTimestamp}));
 await assert.rejects(costWindow({...args(f),seconds:1000,windowEndTimestamp:1600}),/predates chain history/);
});

test('recent fixed windows work when the provider has pruned unrelated ancient block history',async()=>{
 const last=2000000,stamp=n=>1000+n*12,queries=[];
 const rpc=async(m,p)=>{
  if(m==='eth_chainId')return '0xaa36a7';
  if(m==='eth_getBlockByNumber'){
   const n=p[0]==='finalized'?last:Number(BigInt(p[0]));queries.push(n);
   assert.ok(n>=1000000,'pruned history unavailable');return {number:hex(n),hash:hash(n),timestamp:hex(stamp(n)),transactions:[]};
  }
  if(m==='eth_getTransactionCount'||m==='eth_getBalance')return '0x0';
  if(m==='eth_getCode')return '0x';if(m==='eth_getLogs')return [];throw Error('unexpected method');
 };
 const r=await costWindow({...args({rpc}),seconds:86400,windowEndTimestamp:stamp(last)-6*86400,now:stamp(last)*1000});
 assert.equal(r.status,'COMPLETE');assert.equal(r.gasFeeWei,'0');assert.ok(queries.every(n=>n>=1000000));
});

test('zero blob gas without a blob price is valid; positive blob gas still requires its price',async()=>{
 const f=fixture();f.receipts[0].blobGasUsed='0x0';assert.equal((await costWindow(args(f))).gasFeeWei,'52');
 f.receipts[0].blobGasUsed='0x2';await assert.rejects(costWindow(args(f)));
 f.receipts[0].blobGasPrice='0x3';assert.equal((await costWindow(args(f))).gasFeeWei,'58');
});
