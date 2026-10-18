// Read-only status and exit/claim preflight for the authorized MetaMask test pair.
// Never signs, queues, retries a send, or changes either account.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
import {readAccount} from '../indexer/accounts.mjs';
import {sel,uint} from '../indexer/zk-challenge.mjs';

const manifest=JSON.parse(fs.readFileSync('contracts/deployments/sepolia-header-v3.json'));
const owner='0x6657289562f870677325124f3acbdebb0ea80b95';
const pool='0x8cdf42009548483f25fe4bcd6ac00bbb88e2bf14';
assert.equal(manifest.chainId,11155111);
assert.ok(manifest.accounts.pools.some(p=>p.address.toLowerCase()===pool));
const rpc=(method,params)=>rpcRequest(manifest.rpc,method,params);
assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
const block=await rpc('eth_getBlockByNumber',['latest',false]);
assert.ok(Math.abs(Date.now()/1000-Number(BigInt(block.timestamp)))<120,'stale RPC block');
const read=(to,data)=>rpc('eth_call',[{to,data},block.number]);
const view=async(to,sig)=>BigInt(await read(to,sel(sig)));
const poolIndex=await read(pool,sel('index()'));
assert.equal('0x'+poolIndex.slice(-40),manifest.WujiHeaderIndex.toLowerCase());
const accounts=[];
for(const id of [3,4]){
 const account=await readAccount(read,pool,id);
 if(!account.closed){assert.equal(account.owner,owner);assert.equal(account.side,id===3?'yang':'yin');}
 const simulations={};
 if(!account.closed)for(const sig of ['requestExit(uint256)','claim(uint256)']){
  try{await rpc('eth_call',[{from:owner,to:pool,data:sel(sig)+uint(id)},block.number]);simulations[sig]={callable:true};}
  catch(e){
   // A transport failure is not evidence that the contract rejected the action.
   if(!/execution reverted|entry pending|not claimable|same epoch|settlement pending|exit pending|relay stale|pool frozen/i.test(e.message))throw e;
   simulations[sig]={callable:false,reason:e.message};
  }
 }
 if(account.status==='entering'){
  assert.equal(simulations['requestExit(uint256)'].callable,false,'unpriced account unexpectedly exits');
  assert.equal(simulations['claim(uint256)'].callable,false,'unpriced account unexpectedly claims');
 }
 accounts.push({...account,simulations,nextAction:account.closed?'verify closure and payment receipts':account.status==='entering'?'wait for entry pricing':account.status==='open'?'request exit with user signature':account.status==='exiting'?'wait for exit pricing':'claim with user signature'});
}
const accounting={};
for(const sig of ['pendingPrincipal()','refundReserve()','reservedClaims()','buffer()','badDebt()','settling()','insolvent()'])accounting[sig]=(await view(pool,sig)).toString();
const balance=BigInt(await read(manifest.accounts.collateral.address,sel('balanceOf(address)')+owner.slice(2).padStart(64,'0')));
const poolBalance=BigInt(await read(manifest.accounts.collateral.address,sel('balanceOf(address)')+pool.slice(2).padStart(64,'0')));
const protectedCash=BigInt(accounting['pendingPrincipal()'])+BigInt(accounting['refundReserve()'])+BigInt(accounting['reservedClaims()'])+BigInt(accounting['buffer()']);
assert.ok(poolBalance>=protectedCash,'protected reserves exceed actual token balance');
const indexHeight=Number(await view(manifest.WujiHeaderIndex,'lastHeight()'));
const confirmations=Number(await view(manifest.WujiHeaderIndex,'CONFIRMATIONS()'));assert.equal(confirmations,100);
assert.equal((await rpc('eth_getBlockByNumber',[block.number,false])).hash,block.hash,'snapshot reorganized');
const result={checkedAt:new Date().toISOString(),status:'PASS',chainId:11155111,pool,owner,evmBlock:block.number,evmBlockHash:block.hash,indexHeight,confirmations,accounts,accounting,poolWethWei:poolBalance.toString(),walletWethWei:balance.toString(),protectedCashWei:protectedCash.toString(),scope:'Pinned-block public reads and eth_call only. No signatures, transactions, auto exits or claims. Reserve floor is not a proof of all live claims or protocol solvency.'};
if(process.env.WALLET_CHECK_OUTPUT)fs.writeFileSync(process.env.WALLET_CHECK_OUTPUT,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
