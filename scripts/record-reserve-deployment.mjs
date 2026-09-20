// Record public deployment evidence only; never copies signed transaction payloads or keystore data.
import fs from 'node:fs';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import os from 'node:os';import path from 'node:path';
const baseline=JSON.parse(fs.readFileSync('contracts/deployments/bsc-testnet-rewards-v1.json'));
const broadcast=JSON.parse(fs.readFileSync('contracts/broadcast/Deploy.s.sol/97/run-latest.json'));
const output=process.env.MANIFEST||'contracts/deployments/bsc-testnet-reserve-v2.json';
const sourceCommit=process.env.DEPLOYMENT_COMMIT;
assert.match(sourceCommit||'',/^[0-9a-f]{40}$/,'DEPLOYMENT_COMMIT required');
const rpcUrl=baseline.rpc;
async function rpc(method,params){const r=await(await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)})).json();if(r.error)throw Error(r.error.message);return r.result;}
assert.equal(Number(BigInt(await rpc('eth_chainId',[]))),97);
const j={...baseline,version:'bitcoin-reserve-v2',sourceCommit,deployedAt:new Date().toISOString(),status:'receipts-pending',rewardBps:10000,bountyDivisor:10000};
for(const t of broadcast.transactions.filter(t=>t.transactionType==='CREATE'))j[t.contractName]=t.contractAddress;
j.treasury=j.FeeRouter;j.transactions=broadcast.transactions.map(t=>({hash:t.hash,name:t.contractName,operation:t.function||'CREATE',address:t.contractAddress}));
j.vaults={};j.rewardTokens=[];
fs.writeFileSync(output,JSON.stringify(j,null,2)+'\n');
const receipts=await Promise.all(broadcast.transactions.map(t=>rpc('eth_getTransactionReceipt',[t.hash])));
for(let i=0;i<receipts.length;++i){const r=receipts[i];j.transactions[i]={...j.transactions[i],status:r?.status||'pending',block:r?Number(BigInt(r.blockNumber)):null,gasUsed:r?Number(BigInt(r.gasUsed)):null};}
fs.writeFileSync(output,JSON.stringify(j,null,2)+'\n');
assert.ok(receipts.every(r=>r?.status==='0x1'),'not all deployment receipts confirmed');
const cast=process.env.CAST||path.join(os.homedir(),'.foundry/bin/cast');
for(const t of broadcast.transactions.filter(t=>t.function==='create(address,uint256)')){
 const [asset,notional]=t.arguments;
 const address=execFileSync(cast,['call',j.WujiVaultFactory,'vaultFor(address,uint256)(address)',asset,notional,'--rpc-url',rpcUrl],{encoding:'utf8'}).trim();
 const symbol=asset.toLowerCase()===j.MockUSDT.toLowerCase()?'USDT':asset.toLowerCase()===j.MockWBNB.toLowerCase()?'WBNB':asset;
 j.vaults[symbol]={address,asset,notional};j.rewardTokens.push(asset.toLowerCase());
}
j.rewardTokens=[...new Set(j.rewardTokens)].sort();j.status='confirmed';
fs.writeFileSync(output,JSON.stringify(j,null,2)+'\n');console.log(JSON.stringify({manifest:output,transactions:j.transactions.length,contracts:{relay:j.BitcoinRelay,index:j.WujiIndex,reserve:j.RelayerRewards},vaults:j.vaults},null,2));
