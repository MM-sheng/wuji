import test from 'node:test';import assert from 'node:assert/strict';
import {estimateKeeperGas} from './keeper-gas.mjs';
const from='0x'+'11'.repeat(20),to='0x'+'22'.repeat(20);
function fixture(estimate,blockGas=200_000_000){const calls=[];return {calls,rpc:async(method,args)=>{calls.push({method,args});if(method==='eth_getBlockByNumber')return{gasLimit:'0x'+blockGas.toString(16)};if(estimate instanceof Error)throw estimate;return '0x'+estimate.toString(16);},from,to,data:'0x1234',fallbackGas:8_000_000,maxGas:50_000_000};}
test('live state creation can exceed the old fixed execution estimate',async()=>{
 const f=fixture(13_000_000);assert.equal(await estimateKeeperGas({...f,value:'123'}),16_250_000);
 assert.deepEqual(f.calls[1].args[0],{from,to,data:'0x1234',gas:'0x2faf080',value:'0x7b'});
});
test('small estimates preserve the existing allowance',async()=>assert.equal(await estimateKeeperGas(fixture(1_000_000)),8_000_000));
test('operator and block ceilings reject before broadcasting',async()=>{
 await assert.rejects(estimateKeeperGas(fixture(41_000_000)),/ceiling/);
 await assert.rejects(estimateKeeperGas(fixture(13_000_000,15_000_000)),/ceiling/);
 await assert.rejects(estimateKeeperGas({...fixture(1),maxGas:NaN}),/invalid/);
});
test('reverts and invalid estimates cannot degrade to a fixed gas fallback',async()=>{
 await assert.rejects(estimateKeeperGas(fixture(Error('execution reverted'))),/execution reverted/);
 await assert.rejects(estimateKeeperGas(fixture(0)),/invalid/);
});
