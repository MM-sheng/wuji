// One human-authorized Sepolia-only keeper top-up. This is not an automatic refuelling policy.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {execFileSync,execFile} from 'node:child_process';import {promisify} from 'node:util';import {rpcRequest} from '../indexer/evm-rpc.mjs';
const execute=process.argv.includes('--execute'),cast=path.join(os.homedir(),'.foundry/bin/cast'),exec=promisify(execFile);
const url='https://ethereum-sepolia-rpc.publicnode.com',rpc=(m,p)=>rpcRequest(url,m,p,{attempts:2});
const source='0x85967858e2464535a12031103aba38f2795fe8fd',target='0x27b2474c8ca832d25c301ea43cf90c57c5a2dcd2';
const goal=60000000000000000n,file='contracts/deployments/t13-keeper-topup-2026-10-23.json';
assert.ok(!fs.existsSync(file),'funding journal exists; inspect the earlier send, never blindly repeat');
const env=fs.readFileSync('contracts/.env.sepolia','utf8');
const setting=name=>{const match=env.match(new RegExp('^(?:export\\s+)?'+name+'=(.*)$','m'));assert.ok(match,'missing signer configuration');return match[1].trim().replace(/^(['"])(.*)\1$/,'$2');};
const account=setting('KEYSTORE_ACCOUNT'),passwordFile=path.resolve('contracts',setting('PASSWORD_FILE'));
assert.equal(account,'wuji-sepolia');const auth=['--account',account,'--password-file',passwordFile];
assert.equal(execFileSync(cast,['wallet','address',...auth],{encoding:'utf8'}).trim().toLowerCase(),source);
assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
const block=await rpc('eth_getBlockByNumber',['latest',false]);assert.ok(Math.abs(Date.now()/1000-Number(BigInt(block.timestamp)))<120,'stale RPC');
const [sourceBalance,before,sNonce,sPending,tNonce,tPending,sCode,tCode]=await Promise.all([
 rpc('eth_getBalance',[source,block.number]),rpc('eth_getBalance',[target,block.number]),rpc('eth_getTransactionCount',[source,'latest']),rpc('eth_getTransactionCount',[source,'pending']),rpc('eth_getTransactionCount',[target,'latest']),rpc('eth_getTransactionCount',[target,'pending']),rpc('eth_getCode',[source,block.number]),rpc('eth_getCode',[target,block.number])]);
assert.equal(sNonce,sPending,'deployer has a pending transaction');assert.equal(tNonce,tPending,'keeper has a pending transaction');assert.equal(sCode,'0x');assert.equal(tCode,'0x');
const value=goal-BigInt(before);assert.ok(value>0n&&value<=goal,'keeper already at target or unexpected balance');
const gasPrice=100000000n;assert.ok(BigInt(block.baseFeePerGas)<=gasPrice,'gas price above the approved planning scenario');
const tx={from:source,to:target,value:'0x'+value.toString(16),data:'0x'};
await rpc('eth_call',[tx,'latest']);const estimate=BigInt(await rpc('eth_estimateGas',[tx]));const gas=(estimate*125n+99n)/100n;assert.ok(gas<=50000n,'unexpected gas');
assert.ok(BigInt(sourceBalance)>=value+gas*gasPrice,'insufficient deployer balance');
const record={preparedAt:new Date().toISOString(),chainId:11155111,source,target,targetBalanceWei:String(goal),valueWei:String(value),sourceBeforeWei:String(BigInt(sourceBalance)),targetBeforeWei:String(BigInt(before)),nonce:sNonce,targetNonce:tNonce,initialBlock:block.number,initialBlockHash:block.hash,estimateGas:String(estimate),gasLimit:String(gas),gasPriceWei:String(gasPrice),status:'preflight',authorization:'User requested one transfer from deployer to reach 0.06 Sepolia ETH; no standing funding policy.'};
if(!execute){console.log(JSON.stringify(record));process.exit(0);}
// Recheck context immediately before the only broadcast; persist intent before invoking the signer.
assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);assert.equal(await rpc('eth_getTransactionCount',[source,'pending']),sNonce);assert.equal(await rpc('eth_getTransactionCount',[target,'pending']),tNonce);assert.equal(BigInt(await rpc('eth_getBalance',[target,'latest'])),BigInt(before));
assert.equal((await rpc('eth_getBlockByNumber',[block.number,false])).hash,block.hash);
record.status='broadcast-needs-review';fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
try{
 const {stdout}=await exec(cast,['send',target,'--data','0x','--value',String(value),'--nonce',String(BigInt(sNonce)),'--gas-limit',String(gas),'--legacy','--gas-price',String(gasPrice),'--rpc-url',url,'--chain','11155111',...auth,'--json'],{timeout:180000,maxBuffer:2**20});
 const received=JSON.parse(stdout);record.transactionHash=received.transactionHash;fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');
 const receipt=await rpc('eth_getTransactionReceipt',[received.transactionHash]),actual=await rpc('eth_getTransactionByHash',[received.transactionHash]);
 assert.equal(receipt.status,'0x1');assert.equal(BigInt(actual.chainId),11155111n);assert.equal(actual.from.toLowerCase(),source);assert.equal(actual.to.toLowerCase(),target);assert.equal(BigInt(actual.value),value);assert.equal(actual.input,'0x');assert.equal(actual.nonce,sNonce);
 const [after,sourceAfter,canonical]=await Promise.all([rpc('eth_getBalance',[target,receipt.blockNumber]),rpc('eth_getBalance',[source,receipt.blockNumber]),rpc('eth_getBlockByNumber',[receipt.blockNumber,false])]);assert.equal(canonical.hash,receipt.blockHash);assert.equal(actual.blockHash,canonical.hash);
 assert.equal(BigInt(after),goal,'keeper spent concurrently; inspect receipt before any further top-up');
 const fee=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice);assert.equal(BigInt(sourceAfter),BigInt(sourceBalance)-value-fee);
 Object.assign(record,{status:'confirmed',confirmedAt:new Date().toISOString(),transaction:actual,receipt,targetAfterWei:String(BigInt(after)),sourceAfterWei:String(BigInt(sourceAfter)),gasFeeWei:String(fee)});
 fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({status:record.status,hash:record.transactionHash,sentWei:record.valueWei,keeperAfterWei:record.targetAfterWei,deployerAfterWei:record.sourceAfterWei,gasFeeWei:record.gasFeeWei}));
}catch{console.error('Funding outcome needs receipt/nonce review. Journal retained; do not rerun the send.');process.exitCode=1;}
