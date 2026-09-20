// Public receipt evidence only. Run from repo root after deploy-sepolia.sh --broadcast.
import fs from 'node:fs';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import os from 'node:os';import path from 'node:path';
import {network,assertChain} from '../indexer/networks.mjs';
const net=network(11155111),rpcUrl=process.env.DEPLOY_RPC||net.rpc;
const output=process.env.MANIFEST||'contracts/deployments/sepolia-weth-v3.json';
assert.ok(!fs.existsSync(output),'manifest already exists; choose a new file for a new deployment');
const sourceCommit=process.env.DEPLOYMENT_COMMIT;assert.match(sourceCommit||'',/^[0-9a-f]{40}$/,'DEPLOYMENT_COMMIT required');
const broadcast=JSON.parse(fs.readFileSync('contracts/broadcast/Deploy.s.sol/11155111/run-latest.json'));
const checkpoint=JSON.parse(fs.readFileSync('contracts/deployments/bitcoin-checkpoint.json'));
const rpc=async(method,params)=>{const r=await(await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)})).json();if(r.error)throw Error(r.error.message);return r.result;};
assertChain(await rpc('eth_chainId',[]),11155111);
const names=['RelayerRewards','BitcoinRelay','WujiIndex','FeeRouter','SeriesTokenDeployer','WujiVaultFactory'];
assert.equal(broadcast.transactions.length,7,'expected six deployments and one WETH vault creation');
const j={chainId:11155111,source:'bitcoin',version:'bitcoin-sepolia-v3',rpc:rpcUrl,explorer:net.explorer,sourceCommit,deployedAt:new Date().toISOString(),genesisHeight:checkpoint.genesisHeight,checkpointInterval:4320,confirmations:6,unitWad:'12000000000000',maxFutureBlockTime:7200,maxRelayAge:10800,rewardBps:10000,bountyDivisor:10000,checkpoint,status:'receipts-pending',transactions:[],vaults:{}};
for(const name of names){const t=broadcast.transactions.find(t=>t.transactionType==='CREATE'&&t.contractName===name);assert.ok(t,`missing ${name}`);j[name]=t.contractAddress;}
for(const t of broadcast.transactions){assert.match(t.hash,/^0x[0-9a-f]{64}$/);const r=await rpc('eth_getTransactionReceipt',[t.hash]);assert.equal(r?.status,'0x1','deployment receipt not successful');j.transactions.push({hash:t.hash,name:t.contractName,operation:t.function||'CREATE',address:t.contractAddress,status:r.status,block:Number(BigInt(r.blockNumber)),gasUsed:Number(BigInt(r.gasUsed))});}
const create=broadcast.transactions.find(t=>t.function==='create(address,uint256)'),[asset,notional]=create.arguments;
assert.equal(asset.toLowerCase(),'0xfff9976782d46cc05630d1f6ebab18b2324d6b14');assert.equal(BigInt(notional),1000000000000000n);
const cast=process.env.CAST||path.join(os.homedir(),'.foundry/bin/cast');
const address=execFileSync(cast,['call',j.WujiVaultFactory,'vaultFor(address,uint256)(address)',asset,notional,'--rpc-url',rpcUrl],{encoding:'utf8'}).trim();
assert.notEqual(BigInt(address),0n);j.vaults.WETH={address,asset,notional};j.rewardTokens=[asset.toLowerCase()];j.treasury=j.FeeRouter;j.status='confirmed';
fs.writeFileSync(output,JSON.stringify(j,null,2)+'\n',{flag:'wx'});console.log('Recorded',output);
