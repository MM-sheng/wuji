// Testnet only. Wrap test ETH, fund the reserve, mint/redeem one pair and route its fees.
// Source contracts/.env.sepolia in the shell; never pass keys or passwords as command arguments.
import fs from 'node:fs';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import os from 'node:os';import path from 'node:path';
const j=JSON.parse(fs.readFileSync(process.env.MANIFEST||'contracts/deployments/sepolia-weth-v3.json'));
assert.equal(j.chainId,11155111);assert.equal(j.status,'confirmed');
const output=process.env.SMOKE_OUTPUT||'contracts/deployments/sepolia-smoke.json';assert.ok(!fs.existsSync(output),'smoke evidence already exists; inspect before repeating donations');
const cast=process.env.CAST||path.join(os.homedir(),'.foundry/bin/cast');
const run=(...args)=>execFileSync(cast,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const call=(to,sig,...args)=>run('call',to,sig,...args,'--rpc-url',j.rpc);
const number=s=>BigInt(s.split(' ')[0]);
const account=process.env.KEYSTORE_ACCOUNT,password=process.env.PASSWORD_FILE;assert.ok(account&&password);
const worker=run('wallet','address','--account',account,'--password-file',password);
assert.equal(worker.toLowerCase(),process.env.DEPLOYER?.toLowerCase());
const v=j.vaults.WETH,asset=v.asset,notional=BigInt(v.notional),fee=notional*5n/10000n;
assert.equal(number(call(v.address,'liabilities()(uint256)')),0n,'use a fresh isolated test vault');
const before={asset:number(call(asset,'balanceOf(address)(uint256)',worker)),vault:number(call(asset,'balanceOf(address)(uint256)',v.address)),reserve:number(call(j.RelayerRewards,'reserve(address)(uint256)',asset))};
const result={chainId:j.chainId,manifest:process.env.MANIFEST||'contracts/deployments/sepolia-weth-v3.json',worker,startedAt:new Date().toISOString(),status:'incomplete',transactions:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
const send=(to,sig,args=[],extra=[])=>{
 assert.equal(Number(run('chain-id','--rpc-url',j.rpc)),11155111,'wrong signing chain');
 const r=JSON.parse(run('send',to,sig,...args,...extra,'--rpc-url',j.rpc,'--chain','11155111','--account',account,'--password-file',password,'--json'));
 result.transactions.push({operation:sig,to,hash:r.transactionHash,status:r.status,block:Number(BigInt(r.blockNumber)),gasUsed:Number(BigInt(r.gasUsed))});save();assert.equal(r.status,'0x1',sig+' reverted');console.log(sig,r.transactionHash);
};
const wrap=3000000000000000n,funding=1000000000000000n;
send(asset,'deposit()',[],['--value',wrap.toString()]);
send(asset,'approve(address,uint256)',[j.RelayerRewards,funding.toString()]);
send(j.RelayerRewards,'fund(address,uint256)',[asset,funding.toString()]);
send(asset,'approve(address,uint256)',[v.address,(notional+fee).toString()]);
const id=call(v.address,'currentId()(uint256)').split(' ')[0];
send(v.address,'mint(uint256)',['1000000000000000000']);
assert.equal(number(call(v.address,'liabilities()(uint256)')),notional);
send(v.address,'redeemPair(uint256,uint256)',[id,'1000000000000000000']);
send(j.FeeRouter,'route(address)',[asset]);
assert.equal(number(call(v.address,'liabilities()(uint256)')),0n);
assert.equal(number(call(asset,'balanceOf(address)(uint256)',v.address)),before.vault);
assert.equal(number(call(asset,'balanceOf(address)(uint256)',worker)),before.asset+wrap-funding-2n*fee);
assert.equal(number(call(j.RelayerRewards,'reserve(address)(uint256)',asset)),before.reserve+funding+2n*fee);
assert.equal(number(call(asset,'balanceOf(address)(uint256)',j.FeeRouter)),0n);
result.status='confirmed';result.completedAt=new Date().toISOString();result.checks={wrapped:wrap,funded:funding,fees:2n*fee,liabilitiesAfter:0,walletDelta:wrap-funding-2n*fee,reserveDelta:funding+2n*fee};save();console.log('PASS',output);
