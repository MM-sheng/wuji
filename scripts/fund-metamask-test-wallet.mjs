// Sepolia only: prepare the already-connected historical WUJI test account for UI acceptance.
// Source contracts/.env.sepolia. Never import the deployer into MetaMask.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {execFileSync,execFile} from 'node:child_process';import {promisify} from 'node:util';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
const exec=promisify(execFile),cast=path.join(os.homedir(),'.foundry/bin/cast');
const url='https://ethereum-sepolia-rpc.publicnode.com',rpc=(m,p)=>rpcRequest(url,m,p);
const source='0x85967858e2464535a12031103aba38f2795fe8fd',target='0x6657289562f870677325124f3acbdebb0ea80b95';
const asset='0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const file='contracts/deployments/t13-metamask-funding-2026-10-18.json';
assert.ok(!fs.existsSync(file),'funding journal exists: inspect it before any repeat');
assert.equal(process.env.KEYSTORE_ACCOUNT,'wuji-sepolia');assert.ok(process.env.PASSWORD_FILE);
const auth=['--account',process.env.KEYSTORE_ACCOUNT,'--password-file',process.env.PASSWORD_FILE];
assert.equal(execFileSync(cast,['wallet','address',...auth],{encoding:'utf8'}).trim().toLowerCase(),source);
const calldata=(sig,...args)=>execFileSync(cast,['calldata',sig,...args],{encoding:'utf8'}).trim();
const tokenBalance=(address,at)=>rpc('eth_call',[{to:asset,data:calldata('balanceOf(address)',address)},at]).then(BigInt);
assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
const initial=await rpc('eth_getBlockByNumber',['latest',false]);
const [eth,weth,sourceEth]=await Promise.all([rpc('eth_getBalance',[target,initial.number]).then(BigInt),tokenBalance(target,initial.number),rpc('eth_getBalance',[source,initial.number]).then(BigInt)]);
const gasTarget=2000000000000000n,tokenTarget=20000000000000n;
const gasAmount=eth<gasTarget?gasTarget-eth:0n,tokenAmount=weth<tokenTarget?tokenTarget-weth:0n;
assert.ok(gasAmount<=2000000000000000n&&tokenAmount<=20000000000000n);
assert.ok(sourceEth>=gasAmount+tokenAmount+500000000000000n,'deployer fuel too low');
const state={startedAt:new Date().toISOString(),status:'in-progress',chainId:11155111,source,target,asset,
  purpose:'MetaMask UI test gas and two 0.00001 WETH entries',initialBlock:initial.number,
  before:{ethWei:eth.toString(),wethWei:weth.toString()},plannedGasWei:gasAmount.toString(),plannedWethWei:tokenAmount.toString(),operations:[]};
const save=()=>fs.writeFileSync(file,JSON.stringify(state,null,2)+'\n');save();
async function send(label,to,data,value=0n){
  assert.ok(!state.intent,'uncertain earlier broadcast: inspect before continuing');
  assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
  const [nonce,pending,block]=await Promise.all([rpc('eth_getTransactionCount',[source,'latest']),rpc('eth_getTransactionCount',[source,'pending']),rpc('eth_getBlockByNumber',['latest',false])]);
  assert.equal(nonce,pending,'deployer has another pending transaction');
  const gasPrice=100000000n;assert.ok(BigInt(block.baseFeePerGas||'0x0')<=gasPrice,'base fee exceeds budget');
  const tx={from:source,to,data,value:'0x'+value.toString(16)};
  await rpc('eth_call',[tx,'latest']);
  const gas=BigInt(await rpc('eth_estimateGas',[tx]))*130n/100n;assert.ok(gas<=500000n,'unexpected funding gas');
  state.intent={label,to,data,valueWei:value.toString(),nonce};save();
  const {stdout}=await exec(cast,['send',to,'--data',data,'--value',value.toString(),'--nonce',String(BigInt(nonce)),
    '--gas-limit',gas.toString(),'--legacy','--gas-price',gasPrice.toString(),'--rpc-url',url,'--chain','11155111',...auth,'--json'],{timeout:180000,maxBuffer:2**20});
  const receipt=JSON.parse(stdout);state.operations.push({...state.intent,receipt});state.intent=null;save();
  assert.equal(receipt.status,'0x1',label+' reverted');
  const transaction=await rpc('eth_getTransactionByHash',[receipt.transactionHash]);
  assert.equal(transaction.from,source);assert.equal(transaction.to,to);assert.equal(transaction.input,data);assert.equal(BigInt(transaction.value),value);
  assert.equal((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false])).hash,receipt.blockHash);
  console.log(label,receipt.transactionHash);
}
try{
  if(gasAmount)await send('gas-top-up',target,'0x',gasAmount);
  if(tokenAmount){
    const have=await tokenBalance(source,'latest');
    if(have<tokenAmount)await send('wrap-test-eth',asset,calldata('deposit()'),tokenAmount-have);
    await send('fund-test-weth',asset,calldata('transfer(address,uint256)',target,tokenAmount.toString()));
  }
  const block=await rpc('eth_getBlockByNumber',['latest',false]);
  const [ethAfter,wethAfter]=await Promise.all([rpc('eth_getBalance',[target,block.number]).then(BigInt),tokenBalance(target,block.number)]);
  assert.equal(ethAfter,eth+gasAmount);assert.equal(wethAfter,weth+tokenAmount);
  state.status='confirmed';state.completedAt=new Date().toISOString();state.observedBlock=block.number;state.observedBlockHash=block.hash;
  state.after={ethWei:ethAfter.toString(),wethWei:wethAfter.toString()};save();console.log(JSON.stringify(state.after));
}catch(e){state.status=state.intent?'broadcast-needs-review':'failed';state.error=e.message;save();throw e;}
