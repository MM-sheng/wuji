// Pinned, read-only public state for human wallet cancellation and first-upgrade acceptance.
import fs from 'node:fs';import assert from 'node:assert/strict';
import {rpcRequest} from '../indexer/evm-rpc.mjs';import {sel} from '../indexer/zk-challenge.mjs';
const owner=process.argv[2]?.toLowerCase(),output=process.argv[3];
assert.match(owner||'',/^0x[0-9a-f]{40}$/);assert.ok(output&&!fs.existsSync(output),'provide a new evidence file');
const pool='0x8cdf42009548483f25fe4bcd6ac00bbb88e2bf14',asset='0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const rpc=(m,p)=>rpcRequest('https://ethereum-sepolia-rpc.publicnode.com',m,p),word=a=>a.slice(2).padStart(64,'0');
assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
const block=await rpc('eth_getBlockByNumber',['latest',false]);assert.ok(Math.abs(Date.now()/1000-Number(BigInt(block.timestamp)))<120);
const read=(to,data)=>rpc('eth_call',[{to,data},block.number]);
const [balance,code,nonce,pending,weth,allowance,nextId]=await Promise.all([
 rpc('eth_getBalance',[owner,block.number]),rpc('eth_getCode',[owner,block.number]),rpc('eth_getTransactionCount',[owner,block.number]),
 rpc('eth_getTransactionCount',[owner,'pending']),read(asset,sel('balanceOf(address)')+word(owner)),
 read(asset,sel('allowance(address,address)')+word(owner)+word(pool)),read(pool,sel('nextId()'))]);
assert.equal((await rpc('eth_getBlockByNumber',[block.number,false])).hash,block.hash,'snapshot changed');
const result={at:new Date().toISOString(),owner,pool,asset,chainId:11155111,block:block.number,blockHash:block.hash,
 ethWei:BigInt(balance).toString(),code,nonce:BigInt(nonce).toString(),pendingNonce:BigInt(pending).toString(),
 wethWei:BigInt(weth).toString(),allowanceWei:BigInt(allowance).toString(),nextId:BigInt(nextId).toString(),
 scope:'Public reads only. An unchanged nonce/balance alone is not proof of a human rejection; pair with real UI and user action.'};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
