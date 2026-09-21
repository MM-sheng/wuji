import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import os from 'node:os';import path from 'node:path';
import {keeperReads,quantity,workerReady} from './keeper-rpc.mjs';
const cast=process.env.CAST||path.join(os.homedir(),'.foundry/bin/cast');
const to='0x'+'11'.repeat(20),worker='0x'+'22'.repeat(20),word=n=>'0x'+BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0');
const codec=(...args)=>execFileSync(cast,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

test('direct calls preserve actual ABI selectors, arguments and typed return values',async()=>{
 for(const [sig,args,raw,expected,data] of [
  ['lastHeight()(uint64)',[],word(968055),'968055 [9.68e5]','0x25159aa9'],
  ['S()(int256)',[],word(-63144000000000000n),'-63144000000000000 [-6.314e16]','0x4be1c796'],
  ['headerAt(uint64)(bytes32)',['968055'],word(123),word(123),'0xec1867e3'+word(968055).slice(2)],
  ['asset()(address)',[],word(to),to,'0x38d52e0f'],
 ]){
  const requests=[];const call=keeperReads(async(m,p)=>{requests.push([m,p]);return raw;},codec);
  // Numeric annotations vary across Foundry releases; only the actual value is authoritative.
  assert.equal((await call(to,sig,...args)).split(' ')[0],expected.split(' ')[0]);
  assert.deepEqual(requests,[['eth_call',[{to,data},'latest']]]);
 }
});
test('atomic simulation sends the actual worker and the same dynamic ABI payload as signing',async()=>{
 const sig='submitAndFold(bytes,uint256,address[])(uint64)',args=['0x'+'ab'.repeat(80),'16','['+to+']'];let request;
 const call=keeperReads(async(m,p)=>{request=[m,p];return word(16);},codec);
 assert.equal(await call(to,sig,...args,'--from',worker),'16');
 assert.deepEqual(request,['eth_call',[{to,from:worker,data:codec('calldata','submitAndFold(bytes,uint256,address[])',...args)},'latest']]);
});
test('failed or malformed direct reads cannot be decoded as usable state',async()=>{
 let decodes=0;const local=(...a)=>{if(a[0]==='abi-decode')decodes++;return codec(...a);};
 for(const raw of ['0x','0x01','garbage',null])await assert.rejects(keeperReads(async()=>raw,local)(to,'lastHeight()(uint64)'),/Invalid keeper call result/);
 await assert.rejects(keeperReads(async()=>{throw Error('execution reverted: relay stale');},local)(to,'fold(uint256)(uint64)','0'),/relay stale/);
 assert.equal(decodes,0);
});
test('RPC quantities reject noncanonical or non-integer data',()=>{
 for(const raw of ['-1','0x01','0x',1,null,'0xgg'])assert.throws(()=>quantity(raw),/Invalid RPC quantity/);
 assert.equal(quantity('0x0'),0n);assert.equal(quantity('0xa'),10n);
});
const stateRpc=({pending='0x4',balance='0x64',price='0x2'}={})=>async(m,p)=>{
 if(m==='eth_getTransactionCount')return p[1]==='latest'?'0x4':pending;
 if(m==='eth_getBalance')return balance;if(m==='eth_gasPrice')return price;throw Error(m);
};
test('fuel floor uses padded gas limit and allows an exact sampled balance',async()=>{
 await workerReady(stateRpc(),worker,50n);
 await assert.rejects(workerReady(stateRpc(),worker,51n),/Insufficient native balance before signing/);
});
test('legacy fee override determines the fuel floor without an extra fee query',async()=>{
 const base=stateRpc();const rpc=(m,p)=>{assert.notEqual(m,'eth_gasPrice');return base(m,p);};
 await workerReady(rpc,worker,25n,4n);
 await assert.rejects(workerReady(rpc,worker,26n,4n),/Insufficient native balance/);
});
test('pending work or bad account data blocks a new signature',async()=>{
 await assert.rejects(workerReady(stateRpc({pending:'0x5'}),worker,1n),/pending transaction/);
 await assert.rejects(workerReady(stateRpc({balance:'0x01'}),worker,1n),/Invalid RPC quantity/);
});
