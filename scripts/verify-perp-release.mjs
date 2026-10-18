// Run the actual browser release verifier against live Sepolia, without a wallet or signing.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
const html=fs.readFileSync('apps/terminal/index.html','utf8');
const releases=JSON.parse(html.match(/  const PERP_RELEASES=(.+);/)[1]);
const helper=html.slice(html.indexOf('  async function verifyPerpRelease('),html.indexOf('  async function perpSend('));
const manifest=JSON.parse(fs.readFileSync('contracts/deployments/sepolia-header-v3.json'));
const rpc=(m,p)=>rpcRequest(manifest.rpc,m,p);
const owner='0x0000000000000000000000000000000000000001';
const results=[];
for(const deployment of releases)for(const pool of deployment.accountPools){
 const rel={...deployment,...pool};
 assert.equal(rel.index,manifest.WujiHeaderIndex);assert.equal(rel.treasury,manifest.FeeRouter);
 assert.ok(manifest.accounts.pools.some(p=>p.address===rel.address));
 const provider={request:({method,params})=>{
   if(method==='eth_accounts')return Promise.resolve([owner]); // local context only, not a connected wallet
   if(!['eth_chainId','eth_getBlockByNumber','eth_call','eth_getCode'].includes(method))throw Error('read-only verification');
   return rpc(method,params);
 }};
 const ctx=vm.createContext({Date,Uint8Array,crypto:webcrypto,WORD:/^0x[0-9a-f]{64}$/i,word:h=>{assert.match(h,/^0x[0-9a-f]{64}$/i);return BigInt(h);},
   addressWord:h=>{assert.match(h,/^0x[0-9a-f]{64}$/i);assert.equal(BigInt(h)>>160n,0n);return '0x'+h.slice(-40);},
   same:(a,b)=>String(a).toLowerCase()===String(b).toLowerCase(),eth:()=>provider,W:{acct:owner},$:()=>({value:rel.address}),
   requireWalletChain:async expected=>assert.equal(BigInt(await rpc('eth_chainId',[])),BigInt(expected))});
 vm.runInContext(helper+'\nthis.verify=verifyPerpRelease;',ctx);
 const block=await ctx.verify(rel,owner);
 results.push({pool:rel.address,index:rel.index,evmBlock:block.number,evmBlockHash:block.hash,status:'passed',
   codeSha256:rel.codeSha256,indexCodeSha256:rel.indexCodeSha256});
}
const evidence={checkedAt:new Date().toISOString(),chainId:11155111,status:'passed',
 terminalSha256:createHash('sha256').update(html).digest('hex'),results,
 scope:'Live RPC checks using the browser verifier. The local account context is synthetic; no MetaMask connection or transaction.'};
fs.writeFileSync('contracts/deployments/t13-wallet-release-2026-10-18.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
