// Signs eight mock-only BSC testnet transactions using an existing encrypted Foundry account.
// Stop other signers using that account first. Evidence is saved after each receipt; do not blindly rerun failures.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const manifest=process.env.MANIFEST||'contracts/deployments/bsc-testnet-reserve-v2.json';
const j=JSON.parse(fs.readFileSync(manifest));
assert.equal(j.version,'bitcoin-reserve-v2');
assert.equal(j.status,'confirmed');
const output=process.env.SMOKE_OUTPUT||'contracts/deployments/reserve-smoke.json';
assert.ok(!fs.existsSync(output),'evidence already exists: inspect receipts before choosing a new output');
const cast=process.env.CAST||path.join(os.homedir(),'.foundry/bin/cast');
const account=process.env.KEYSTORE_ACCOUNT,password=process.env.PASSWORD_FILE;
assert.ok(account&&password&&path.isAbsolute(password),'encrypted account and absolute password-file path required');
const run=(...args)=>execFileSync(cast,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const call=(to,sig,...args)=>run('call',to,sig,...args,'--rpc-url',j.rpc);
const number=s=>BigInt(s.split(' ')[0]);
assert.equal(run('chain-id','--rpc-url',j.rpc),'97');
const worker=run('wallet','address','--account',account,'--password-file',password);
const result={manifest,sourceCommit:j.sourceCommit,chainId:97,worker,startedAt:new Date().toISOString(),status:'running',transactions:[],assets:{}};
const save=()=>fs.writeFileSync(output,JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
function send(name,to,sig,...args){
 const receipt=JSON.parse(run('send',to,sig,...args,'--rpc-url',j.rpc,'--account',account,'--password-file',password,'--gas-limit','700000','--json'));
 result.transactions.push({name,hash:receipt.transactionHash,status:receipt.status,block:Number(BigInt(receipt.blockNumber)),gasUsed:Number(BigInt(receipt.gasUsed)),effectiveGasPrice:number(receipt.effectiveGasPrice)});save();
 assert.ok(receipt.status==='0x1'||receipt.status===1,name+' reverted');
 console.log(name,receipt.transactionHash);
}
function snapshot(v){
 return {
  height:number(call(j.RelayerRewards,'lastHeight()(uint64)')),
  reserve:number(call(j.RelayerRewards,'reserve(address)(uint256)',v.asset)),
  allocated:number(call(j.RelayerRewards,'allocated(address)(uint256)',v.asset)),
  claimable:number(call(j.RelayerRewards,'claimable(address,address)(uint256)',v.asset,worker)),
  routerBalance:number(call(v.asset,'balanceOf(address)(uint256)',j.FeeRouter)),
  reserveBalance:number(call(v.asset,'balanceOf(address)(uint256)',j.RelayerRewards)),
  deadBalance:number(call(v.asset,'balanceOf(address)(uint256)','0x000000000000000000000000000000000000dEaD')),
  walletBalance:number(call(v.asset,'balanceOf(address)(uint256)',worker)),
  vaultBalance:number(call(v.asset,'balanceOf(address)(uint256)',v.address)),
  liabilities:number(call(v.address,'liabilities()(uint256)'))
 };
}
save();
for(const [symbol,mock] of [['USDT',j.MockUSDT],['WBNB',j.MockWBNB]]){
 const v=j.vaults[symbol];assert.equal(v.asset.toLowerCase(),mock.toLowerCase());
 const before=snapshot(v);assert.equal(before.vaultBalance,0n);assert.equal(before.liabilities,0n);
 const notional=number(call(v.address,'NOTIONAL()(uint256)')),fee=(notional*5n+9999n)/10000n;
 const id=call(v.address,'currentId()(uint256)').split(' ')[0];
 result.assets[symbol]={token:v.asset,vault:v.address,notional,feePerOperation:fee,before};save();
 send(symbol+' approve',v.asset,'approve(address,uint256)',v.address,(notional+fee).toString());
 send(symbol+' mint one pair',v.address,'mint(uint256)','1000000000000000000');
 assert.equal(number(call(v.address,'liabilities()(uint256)')),notional);
 assert.equal(number(call(v.asset,'balanceOf(address)(uint256)',v.address)),notional);
 send(symbol+' redeem one pair',v.address,'redeemPair(uint256,uint256)',id,'1000000000000000000');
 send(symbol+' route all fees',j.FeeRouter,'route(address)',v.asset);
 const after=snapshot(v);result.assets[symbol].after=after;save();
 assert.equal(after.height,before.height,'concurrent folder: compare receipt blocks before drawing accounting conclusions');
 assert.equal(after.reserve,before.reserve+before.routerBalance+2n*fee);
 assert.equal(after.allocated,before.allocated);assert.equal(after.claimable,before.claimable);
 assert.equal(after.reserveBalance,after.reserve+after.allocated);
 assert.equal(after.routerBalance,0n);assert.equal(after.deadBalance,before.deadBalance);
 assert.equal(after.walletBalance,before.walletBalance-2n*fee);
 assert.equal(after.vaultBalance,0n);assert.equal(after.liabilities,0n);
}
result.status='passed';result.completedAt=new Date().toISOString();save();console.log('PASS',output);
