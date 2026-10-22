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
test('nested network causes retain safe codes without exposing URLs or credentials',async()=>{
 const secret='https://user:password@rpc.test/private-key?token=secret';
 const cause=new AggregateError([Object.assign(Error(secret),{code:'ETIMEDOUT'}),Object.assign(Error(secret),{code:'ECONNRESET'})],secret);
 const fetcher=async()=>{throw new TypeError(secret,{cause});};
 await assert.rejects(rpcRequest(secret,'eth_call',[],{fetcher,attempts:1}),e=>{
  assert.equal(e.rpcTransportError,true);assert.match(e.message,/ETIMEDOUT,ECONNRESET/);
  for(const s of ['user','password','private-key','token','secret'])assert.ok(!e.message.includes(s));return true;
 });
});
test('execution errors are not transport failures and client HTTP errors are not retried',async()=>{
 await assert.rejects(rpcRequest('rpc','eth_call',[],{fetcher:async()=>({ok:true,json:async()=>({error:{message:'execution reverted'}})})}),e=>!e.rpcTransportError);
 let n=0;await assert.rejects(rpcRequest('rpc','eth_call',[],{fetcher:async()=>{n++;return {ok:false,status:401};}}),e=>e.rpcTransportError===false&&/HTTP 401/.test(e.message));assert.equal(n,1);
});
test('timeouts are classified and invalid retry budgets fail before fetching',async()=>{
 await assert.rejects(rpcRequest('rpc','eth_call',[],{attempts:1,fetcher:async()=>{throw new DOMException('sensitive URL','TimeoutError');}}),e=>e.rpcTransportError&&/TimeoutError/.test(e.message));
 for(const attempts of [0,-1,NaN,1.5])await assert.rejects(rpcRequest('rpc','eth_call',[],{attempts}),/positive integer/);
});
