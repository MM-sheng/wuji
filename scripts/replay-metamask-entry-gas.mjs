// Reproduce only on an already running loopback Anvil fork at Sepolia block 11938380.
// No private key or public write RPC is used. Start with zero Anvil generated accounts.
import fs from 'node:fs';import assert from 'node:assert/strict';
const {rpcRequest}=await import('../indexer/evm-rpc.mjs');
const r=(m,p)=>rpcRequest('http://127.0.0.1:18547',m,p,{timeoutMs:180000});const doc=JSON.parse(fs.readFileSync('contracts/deployments/t13-metamask-entry-2026-10-18.json'));const t=doc.transaction;
if(BigInt(await r('eth_chainId',[]))!==11155111n)throw Error('wrong local fork');

assert.equal(BigInt(await r('eth_blockNumber',[])),11938380n,'use a fresh fork at the recorded prestate');
await r('anvil_impersonateAccount',[t.from]);
const snapshot=await r('evm_snapshot',[]);let results=[];
for(const gas of [t.gas,'0x'+(1118574n*2n+500000n).toString(16)]){
 if(results.length)await r('evm_revert',[snapshot]);
 await r('evm_setNextBlockTimestamp',[Number(BigInt(t.blockTimestamp))]);
 const hash=await r('eth_sendTransaction',[{from:t.from,to:t.to,data:t.input,value:t.value,gas,nonce:t.nonce,type:t.type,chainId:t.chainId,maxFeePerGas:t.maxFeePerGas,maxPriorityFeePerGas:t.maxPriorityFeePerGas,authorizationList:t.authorizationList}]);
 let receipt; for(let i=0;i<60;i++){receipt=await r('eth_getTransactionReceipt',[hash]);if(receipt)break;await new Promise(resolve=>setTimeout(resolve,1000));} if(!receipt)throw Error('local receipt timeout '+hash);results.push({localOnly:true,gasLimit:Number(BigInt(gas)),receipt});
 console.log(JSON.stringify({gas,hash,status:receipt.status,gasUsed:Number(BigInt(receipt.gasUsed)),logs:receipt.logs.length}));
}
fs.writeFileSync('contracts/deployments/t13-metamask-gas-replay-2026-10-18.json',JSON.stringify({sourceTransaction:t.hash,forkBlock:11938380,scope:'Local fork only, original transaction fields and timestamp, gas limit varied. No public transaction broadcast.',results},null,2)+'\n');

assert.equal(results[0].receipt.status,'0x0');
assert.equal(Number(BigInt(results[0].receipt.gasUsed)),Number(BigInt(doc.receipt.gasUsed)));
assert.equal(results[1].receipt.status,'0x1');
const entry=results[1].receipt.logs.find(l=>l.address.toLowerCase()==='0x8cdf42009548483f25fe4bcd6ac00bbb88e2bf14'&&l.topics[0]==='0x6fb0fa55bce2819ab33da96cdb575107424ba90212579b2264b314a16d6cea88');
assert.ok(entry,'successful replay must emit EnterRequested');
assert.equal(BigInt(entry.topics[1]),3n);
assert.equal('0x'+entry.topics[2].slice(-40),t.from.toLowerCase());
