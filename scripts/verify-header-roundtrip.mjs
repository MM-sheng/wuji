// Read-only re-verification of the v3 lifecycle. Does not sign or repeat any transaction.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { rpcRequest } from '../indexer/evm-rpc.mjs';
import { sel, uint } from '../indexer/zk-challenge.mjs';

const state=JSON.parse(fs.readFileSync('operator/sepolia-header-v3/lifecycle-state.json'));
const rpcURL='https://sepolia.gateway.tenderly.co'; // PublicNode returned null for these historical receipts.
const rpc=(m,p)=>rpcRequest(rpcURL,m,p);
const pool='0x8cdf42009548483f25fe4bcd6ac00bbb88e2bf14';
const owner='0x1405d3d3f81f507be2315bf4708fc9444bbbca3f';
const asset='0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const cast=path.join(os.homedir(),'.foundry/bin/cast');
assert.equal(state.pool.toLowerCase(),pool);assert.equal(state.account.toLowerCase(),owner);
assert.equal(state.phase,'complete');assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
const finalized=await rpc('eth_getBlockByNumber',['finalized',false]);
const snapshot=await rpc('eth_getBlockByNumber',['latest',false]);
const operations=[];
for(const op of state.operations) {
  const [r,t]=await Promise.all([rpc('eth_getTransactionReceipt',[op.hash]),rpc('eth_getTransactionByHash',[op.hash])]);
  assert.equal(r?.status,'0x1',op.label+' missing/failed');assert.equal(r.transactionHash,op.hash);
  assert.equal(t.from,owner);assert.equal(t.to,op.to.toLowerCase());
  assert.equal(BigInt(t.value),BigInt(op.valueWei));
  const data=execFileSync(cast,['calldata',op.sig,...op.args.map(String)],{encoding:'utf8'}).trim();
  assert.equal(t.input,data,op.label+' calldata changed');
  assert.ok(BigInt(r.blockNumber)<=BigInt(finalized.number),op.label+' is not finalized');
  assert.equal((await rpc('eth_getBlockByNumber',[r.blockNumber,false])).hash,r.blockHash,'receipt is not canonical');
  assert.equal(r.blockHash,op.receipt.blockHash,'saved receipt was reorganized');
  operations.push({label:op.label,hash:op.hash,transaction:t,receipt:r});
}
const topic=sig=>execFileSync(cast,['keccak',sig],{encoding:'utf8'}).trim();
const claimedTopic=topic('Claimed(uint256,address,uint256)'),transferTopic=topic('Transfer(address,address,uint256)');
let total=0n;const claims=[];
for(const claim of state.claims) {
  const check=state.claimChecks[claim.id];
  assert.equal((await rpc('eth_getBlockByNumber',[check.evmBlock,false])).hash,check.evmBlockHash);
  const due=BigInt(await rpc('eth_call',[{to:pool,data:sel('claimableOf(uint256)')+uint(claim.id)},check.evmBlock]));
  assert.equal(due,BigInt(check.due));assert.equal(due,BigInt(claim.paidWei));
  const r=operations.find(o=>o.hash===claim.hash).receipt;
  const paid=r.logs.filter(l=>l.address.toLowerCase()===pool&&l.topics[0]===claimedTopic&&BigInt(l.topics[1])===BigInt(claim.id)&&l.topics[2].slice(-40)===owner.slice(2));
  assert.equal(paid.length,1);assert.equal(BigInt(paid[0].data),due);
  const transfers=r.logs.filter(l=>l.address.toLowerCase()===asset&&l.topics[0]===transferTopic&&l.topics[1].slice(-40)===pool.slice(2)&&l.topics[2].slice(-40)===owner.slice(2));
  assert.equal(transfers.reduce((n,l)=>n+BigInt(l.data),0n),due);
  const account=await rpc('eth_call',[{to:pool,data:sel('accounts(uint256)')+uint(claim.id)},snapshot.number]);
  assert.equal(BigInt('0x'+account.slice(2,66)),0n,'account not closed');
  claims.push({id:claim.id,hash:claim.hash,claimableWei:due.toString(),receivedWei:due.toString()});total+=due;
}
assert.equal(claims.length,2);
assert.equal(total,19880180000000n);
const deposited=20000000000000n,entryFees=deposited*30n/10000n,net=deposited-entryFees,exitFees=net*30n/10000n;
assert.equal(total,deposited-entryFees-exitFees,'paired payout fee accounting differs');
const unwrap=operations.find(o=>o.label==='unwrap');
assert.equal(BigInt('0x'+unwrap.transaction.input.slice(10)),total);
const live={};
for(const sig of ['openAccounts()','reservedClaims()','pendingPrincipal()','refundReserve()','badDebt()']) {
  live[sig]=BigInt(await rpc('eth_call',[{to:pool,data:sel(sig)},snapshot.number])).toString();
  assert.equal(live[sig],'0',sig+' still nonzero');
}
assert.equal((await rpc('eth_getBlockByNumber',[snapshot.number,false])).hash,snapshot.hash);
const evidence={verifiedAt:new Date().toISOString(),status:'passed',rpc:rpcURL,chainId:11155111,pool,owner,asset,
  originallyCompletedAt:state.completedAt,evmBlock:snapshot.number,evmBlockHash:snapshot.hash,finalizedBlock:finalized.number,
  entryEpochs:state.entryEpochs,exitEpochs:state.exitEpochs,depositedWei:deposited.toString(),entryFeesWei:entryFees.toString(),
  exitFeesWei:exitFees.toString(),totalReturnedWei:total.toString(),claims,live,operations,
  scope:'Re-verified the October 12–15 encrypted-wallet protocol lifecycle. No new transactions; MetaMask UI acceptance remains separate.'};
fs.writeFileSync('contracts/deployments/t13-roundtrip-verified-2026-10-18.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({...evidence,operations:operations.map(o=>({label:o.label,hash:o.hash}))},null,2));
