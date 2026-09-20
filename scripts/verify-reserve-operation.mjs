// Read-only replay of public reserve events and an exact-height index reconciliation.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
import {step} from '../indexer/bitcoin.mjs';
const manifest=process.env.MANIFEST||'contracts/deployments/bsc-testnet-reserve-v2.json';
const j=JSON.parse(fs.readFileSync(manifest));
assert.ok(['bitcoin-reserve-v2','bitcoin-timestamps-v3','bitcoin-sepolia-v3'].includes(j.version));assert.equal(j.status,'confirmed');
const cast=process.env.CAST||path.join(os.homedir(),'.foundry/bin/cast');
const encode=(...a)=>execFileSync(cast,a,{encoding:'utf8'}).trim();
const readRpc=process.env.READ_RPC||j.rpc;
const rpc=(method,params,endpoint=readRpc)=>rpcRequest(endpoint,method,params);
assert.equal(Number(BigInt(await rpc('eth_chainId',[]))),j.chainId);
const at=await rpc('eth_blockNumber',[]);
const logsRpc=process.env.LOG_RPC||readRpc;
for(const endpoint of new Set([j.rpc,logsRpc].filter(url=>url!==readRpc))){
 assert.equal(Number(BigInt(await rpc('eth_chainId',[],endpoint))),j.chainId);
 const [a,b]=await Promise.all([rpc('eth_getBlockByNumber',[at,false]),rpc('eth_getBlockByNumber',[at,false],endpoint)]);
 assert.ok(a&&b,'event provider has not reached the observation block');
 assert.equal(a.hash,b.hash,'event provider disagrees on the observation block');
}
const call=(to,sig,args=[],block=at)=>rpc('eth_call',[{to,data:encode('calldata',sig,...args)},block]);
const start=Math.min(...j.transactions.map(t=>t.block));
const topics=Object.fromEntries(['Funded(address,address,uint256)','Bounty(address,address,uint64,uint64,uint256)','Claimed(address,address,uint256)'].map(s=>[encode('keccak',s),s.split('(')[0]]));
const events=[];
for(let from=start;from<=Number(BigInt(at));from+=1000){
 events.push(...await rpc('eth_getLogs',[{address:j.RelayerRewards,fromBlock:'0x'+from.toString(16),toBlock:'0x'+Math.min(from+999,Number(BigInt(at))).toString(16),topics:[Object.keys(topics)]}],logsRpc));
}
events.sort((a,b)=>Number(BigInt(a.blockNumber)-BigInt(b.blockNumber))||Number(BigInt(a.logIndex)-BigInt(b.logIndex)));
const assets=new Map(j.rewardTokens.map(t=>[t,{reserve:0n,allocated:0n,funded:0n,paid:0n,workers:new Map(),heights:0n}]));
const evidence=[];
for(const e of events){
 const kind=topics[e.topics[0]],token='0x'+e.topics[1].slice(-40),worker='0x'+e.topics[2].slice(-40),a=assets.get(token);
 if(!a)continue;
 const word=i=>BigInt('0x'+e.data.slice(2+64*i,66+64*i));
 let amount,from,to;
 if(kind==='Funded'){amount=word(0);a.reserve+=amount;a.funded+=amount;}
 if(kind==='Bounty'){
  from=word(0);to=word(1);amount=word(2);assert.ok(to>=from&&to-from<256n);
  let expected=0n;for(let h=from;h<=to;h++){const b=a.reserve/10000n;a.reserve-=b;expected+=b;}
  assert.equal(amount,expected,'per-height bounty differs from the replayed reserve');
  a.heights+=to-from+1n;a.allocated+=amount;a.workers.set(worker,(a.workers.get(worker)||0n)+amount);
 }
 if(kind==='Claimed'){
  amount=word(0);assert.equal(amount,a.workers.get(worker)||0n,'claim exceeds fixed accrued work');
  a.workers.set(worker,0n);a.allocated-=amount;a.paid+=amount;
 }
 evidence.push({kind,token,worker,amount,from,to,hash:e.transactionHash,block:Number(BigInt(e.blockNumber))});
}
for(const [token,a] of assets){
 assert.ok(a.heights>0n&&a.paid>0n,'no live bounty and claim observed');
 assert.equal(BigInt(await call(j.RelayerRewards,'reserve(address)',[token])),a.reserve);
 assert.equal(BigInt(await call(j.RelayerRewards,'allocated(address)',[token])),a.allocated);
 assert.equal(BigInt(await call(token,'balanceOf(address)',[j.RelayerRewards])),a.reserve+a.allocated);
 assert.equal(a.funded,a.reserve+a.allocated+a.paid);
 for(const [worker,claimable] of a.workers)assert.equal(BigInt(await call(j.RelayerRewards,'claimable(address,address)',[token,worker])),claimable);
}
const base=process.env.INDEXER_URL||'http://localhost:8791';
const head=await(await fetch(base+'/head')).json(),c=head.chain;
assert.equal(head.source,'bitcoin');assert.equal(head.halted,false);assert.equal(head.err,null);
assert.equal(c.contract.toLowerCase(),j.WujiIndex.toLowerCase());assert.equal(c.reconciliation,'matched');assert.equal(c.agree,true);
const rows=await(await fetch(base+`/blocks?from=${j.genesisHeight}&to=${c.lastHeight}`)).json();
assert.equal(rows.length,c.lastHeight-j.genesisHeight+1);
let U=0,previous;
for(let i=0;i<rows.length;i++){
 const row=rows[i],s=step(row.header);assert.equal(row.height,j.genesisHeight+i);assert.equal(row.hash,s.hash);
 if(previous)assert.equal(Buffer.from(row.header.slice(8,72),'hex').reverse().toString('hex'),previous);
 U+=s.delta;assert.equal(row.U,U);previous=s.hash;
}
const block='0x'+c.observedAt.toString(16),S=(BigInt(U)*12000000000000n).toString();
assert.equal(BigInt.asIntN(256,BigInt(await call(j.WujiIndex,'S()',[],block))).toString(),S);
assert.equal(Number(BigInt(await call(j.WujiIndex,'lastHeight()',[],block))),c.lastHeight);
assert.equal(await call(j.WujiIndex,'lastHash()',[],block),'0x'+step(rows.at(-1).header).internalHash);
assert.equal(c.S_wad,S);assert.equal(c.indexer_S_wad,S);
const transactions=[];
for(const hash of new Set(evidence.map(e=>e.hash))){
 const r=await rpc('eth_getTransactionReceipt',[hash]);assert.equal(r.status,'0x1');
 transactions.push({hash,status:r.status,block:Number(BigInt(r.blockNumber)),gasUsed:Number(BigInt(r.gasUsed)),effectiveGasPrice:BigInt(r.effectiveGasPrice).toString()});
}
const result={verifiedAt:new Date().toISOString(),manifest,readSource:readRpc,eventSource:logsRpc,sourceCommit:j.sourceCommit,evmBlock:Number(BigInt(at)),events:evidence,transactions,assets:Object.fromEntries([...assets].map(([t,a])=>[t,{...a,workers:Object.fromEntries(a.workers)}])),reconciliation:{evmBlock:c.observedAt,height:c.lastHeight,U,S_wad:S,lastHash:c.lastHash,matched:true,method:'Recomputed every cached raw header, then read contract state at the indexer observation block; this is not the two-source independent verifier planned in T4.'}};
const output=process.env.OPERATION_OUTPUT||'contracts/deployments/reserve-operation.json';
fs.writeFileSync(output,JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log('PASS',output,JSON.stringify(result.reconciliation));
