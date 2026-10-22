// One bounded Sepolia-only gas top-up for the existing human wallet UI test. No WETH or entry calls.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {execFileSync,execFile} from 'node:child_process';import {promisify} from 'node:util';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
const cast=path.join(os.homedir(),'.foundry/bin/cast'),exec=promisify(execFile);
const url='https://ethereum-sepolia-rpc.publicnode.com',rpc=(m,p)=>rpcRequest(url,m,p);
const source='0x85967858e2464535a12031103aba38f2795fe8fd',target='0x6657289562f870677325124f3acbdebb0ea80b95';
const file='contracts/deployments/t13-wallet-ui-gas-2026-10-22.json',amount=3000000000000000n;
assert.ok(!fs.existsSync(file),'existing journal: inspect it; never repeat an uncertain send');
assert.equal(process.env.KEYSTORE_ACCOUNT,'wuji-sepolia');assert.ok(process.env.PASSWORD_FILE);
const auth=['--account',process.env.KEYSTORE_ACCOUNT,'--password-file',process.env.PASSWORD_FILE];
assert.equal(execFileSync(cast,['wallet','address',...auth],{encoding:'utf8'}).trim().toLowerCase(),source);
assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
const block=await rpc('eth_getBlockByNumber',['latest',false]);
const [sourceBalance,before,nonce,pending,targetNonce,targetPending]=await Promise.all([
 rpc('eth_getBalance',[source,block.number]),rpc('eth_getBalance',[target,block.number]),
 rpc('eth_getTransactionCount',[source,'latest']),rpc('eth_getTransactionCount',[source,'pending']),
 rpc('eth_getTransactionCount',[target,'latest']),rpc('eth_getTransactionCount',[target,'pending'])]);
assert.equal(nonce,pending);assert.equal(targetNonce,targetPending,'wallet has a pending transaction');
assert.ok(BigInt(before)<3000000000000000n,'wallet already has enough test fuel for this top-up task');
assert.ok(BigInt(sourceBalance)>amount+500000000000000n,'source has insufficient test fuel');
const gasPrice=100000000n;assert.ok(BigInt(block.baseFeePerGas)<gasPrice);
await rpc('eth_call',[{from:source,to:target,value:'0x'+amount.toString(16),data:'0x'},'latest']);
const estimate=BigInt(await rpc('eth_estimateGas',[{from:source,to:target,value:'0x'+amount.toString(16),data:'0x'}]));
const gas=(estimate*130n+99n)/100n;assert.ok(gas<=500000n);
const record={startedAt:new Date().toISOString(),status:'broadcast-needs-review',chainId:11155111,source,target,valueWei:amount.toString(),nonce,initialBlock:block.number,beforeWei:BigInt(before).toString(),purpose:'Test-only gas to reach the actual MetaMask rejection prompt; no WETH or new position'};
fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');
const {stdout}=await exec(cast,['send',target,'--data','0x','--value',amount.toString(),'--nonce',String(BigInt(nonce)),
 '--gas-limit',gas.toString(),'--legacy','--gas-price',gasPrice.toString(),'--rpc-url',url,'--chain','11155111',...auth,'--json'],{timeout:180000,maxBuffer:2**20});
const receipt=JSON.parse(stdout);record.receipt=receipt;fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');assert.equal(receipt.status,'0x1');
const tx=await rpc('eth_getTransactionByHash',[receipt.transactionHash]);assert.equal(tx.from.toLowerCase(),source);assert.equal(tx.to.toLowerCase(),target);assert.equal(BigInt(tx.value),amount);assert.equal(tx.input,'0x');
assert.equal((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false])).hash,receipt.blockHash);
const after=BigInt(await rpc('eth_getBalance',[target,receipt.blockNumber]));assert.equal(after,BigInt(before)+amount);
Object.assign(record,{status:'confirmed',completedAt:new Date().toISOString(),transaction:tx,afterWei:after.toString(),gasFeeWei:(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)).toString()});
fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({hash:receipt.transactionHash,status:record.status,amount:'.003 Sepolia ETH',afterWei:record.afterWei}));
