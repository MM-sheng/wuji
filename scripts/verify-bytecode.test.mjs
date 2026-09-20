import test from 'node:test';
import assert from 'node:assert/strict';
import {compareRuntime,verifyBytecode} from './verify-bytecode.mjs';
const artifact={deployedBytecode:{object:'0x6001'+'00'.repeat(32)+'aabb',immutableReferences:{x:[{start:2,length:32}]}}};
const deployed='0x6001'+'ff'.repeat(32)+'aabb';
test('only declared immutable bytes may differ',()=>{const r=compareRuntime(artifact,deployed);assert.equal(r.status,'PASS');assert.equal(r.immutableSlots,1);});
test('changed instruction fails',()=>assert.throws(()=>compareRuntime(artifact,deployed.replace('6001','6002')),/runtime mismatch/));
test('changed trailing metadata fails; metadata is never stripped',()=>assert.throws(()=>compareRuntime(artifact,deployed.slice(0,-2)+'cc'),/runtime mismatch/));
test('missing or shortened deployed code fails',()=>{assert.throws(()=>compareRuntime(artifact,'0x'));assert.throws(()=>compareRuntime(artifact,'0x6001'),/length/);});
test('malformed, overlapping or out-of-bounds immutable masks fail',()=>{
 for(const refs of [[{start:-1,length:32}],[{start:3,length:32},{start:2,length:32}],[{start:2,length:34}],[{start:4,length:32}],[{start:0,length:32}]]){
  assert.throws(()=>compareRuntime({deployedBytecode:{...artifact.deployedBytecode,immutableReferences:{x:refs}}},deployed));
 }
});
test('wrong chain rejected before code fetch',async()=>await assert.rejects(verifyBytecode({status:'confirmed',chainId:97,rpc:'mock'},'.',{fetcher:async()=>({ok:true,json:async()=>({result:'0x1'})})}),/wrong settlement chain/));
