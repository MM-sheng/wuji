import test from 'node:test';import assert from 'node:assert/strict';import {rpcRequest} from './evm-rpc.mjs';
test('transient read failures retry the identical pinned request',async()=>{
 const bodies=[];const fetcher=async(_,o)=>{bodies.push(o.body);if(bodies.length<3)throw Error('timeout');return {ok:true,json:async()=>({result:'0x2a'})};};
 assert.equal(await rpcRequest('rpc','eth_call',[{to:'0x123',data:'0x456'},'0x55'],{fetcher,retryDelayMs:0}),'0x2a');assert.equal(bodies.length,3);assert.equal(new Set(bodies).size,1);
});
test('RPC execution errors fail immediately',async()=>{
 let count=0;const fetcher=async()=>{count++;return {ok:true,json:async()=>({error:{message:'execution reverted'}})};};
 await assert.rejects(rpcRequest('rpc','eth_call',[],{fetcher,retryDelayMs:0}),/execution reverted/);assert.equal(count,1);
});
test('transport failure has a bounded retry budget',async()=>{
 let count=0;const fetcher=async()=>{count++;return {ok:false,status:503};};
 await assert.rejects(rpcRequest('rpc','eth_getLogs',[],{fetcher,retryDelayMs:0}),/after 3 attempt/);assert.equal(count,3);
});
test('non-read methods are not automatically retried',async()=>{
 let count=0;const fetcher=async()=>{count++;throw Error('timeout');};
 await assert.rejects(rpcRequest('rpc','eth_sendRawTransaction',['not-a-real-transaction'],{fetcher,retryDelayMs:0}),/after 1 attempt/);assert.equal(count,1);
});
