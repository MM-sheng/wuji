// Public reads only: verify the authorized Sepolia MetaMask pair, never send or sign.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
import {sel,uint} from '../indexer/zk-challenge.mjs';
const dir='contracts/deployments/';
const load=name=>JSON.parse(fs.readFileSync(dir+name));
const save=(name,value)=>fs.writeFileSync(dir+name,JSON.stringify(value,null,2)+'\n');
const rpc=(method,params)=>rpcRequest('https://ethereum-sepolia-rpc.publicnode.com',method,params);
const historical=async(method,params)=>{
 let result=await rpc(method,params);
 if(result===null)result=await rpcRequest('https://sepolia.gateway.tenderly.co',method,params);
 assert.ok(result,`historical RPC data unavailable: ${method}`);return result;
};
const pre=load('t13-wallet-claim-preflight-2026-10-22.json');
const {pool,owner}=pre, weth='0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const claimedTopic='0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026';
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const wordAddress=a=>'0x'+a.slice(2).padStart(64,'0');
assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
assert.equal((await rpc('eth_getBlockByNumber',[pre.evmBlock,false])).hash,pre.evmBlockHash);
const logs=await rpc('eth_getLogs',[{address:pool,fromBlock:pre.evmBlock,toBlock:'latest',topics:[claimedTopic,null,wordAddress(owner)]}]);
const ledger=load('t13-roundtrip-ledger-2026-10-20.json');
const gas=[];
for(const account of ledger.accounts){
 const id=account.id;
 const matching=logs.filter(l=>BigInt(l.topics[1])===BigInt(id)&&!l.removed);
 assert.equal(matching.length,1,`account #${id}: need one confirmed claim before final verification`);
 const log=matching[0];
 const transaction=await rpc('eth_getTransactionByHash',[log.transactionHash]);
 const receipt=await rpc('eth_getTransactionReceipt',[log.transactionHash]);
 const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
 assert.equal(receipt.status,'0x1');assert.equal(receipt.blockHash,block.hash);
 assert.equal(log.blockHash,block.hash);assert.equal(transaction.blockHash,block.hash);
 assert.equal(transaction.from.toLowerCase(),owner);assert.equal(transaction.to.toLowerCase(),pool);
 assert.equal(BigInt(transaction.value),0n);assert.equal(transaction.input,sel('claim(uint256)')+uint(id));
 const gross=BigInt(await rpc('eth_call',[{to:pool,data:sel('valueOf(uint256)')+uint(id)},pre.evmBlock]));
 const feeBps=BigInt(await rpc('eth_call',[{to:pool,data:sel('FEE_BPS()')},pre.evmBlock]));assert.equal(feeBps,30n);
 const exitFee=gross*feeBps/10000n, amount=gross-exitFee;
 assert.equal(BigInt(log.data),amount);assert.equal(String(amount),pre.accounts.find(a=>a.id===id).claimable_wad);
 assert.equal(receipt.logs.filter(l=>l.address.toLowerCase()===pool&&l.topics[0]===claimedTopic&&l.topics[1]===log.topics[1]&&l.topics[2]===wordAddress(owner)&&BigInt(l.data)===amount).length,1);
 const transfers=receipt.logs.filter(l=>l.address.toLowerCase()===weth&&l.topics[0]===transferTopic&&l.topics[1]===wordAddress(pool)&&l.topics[2]===wordAddress(owner));
 assert.equal(transfers.length,1);assert.equal(BigInt(transfers[0].data),amount);
 const gasFeeWei=String(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice));
 save(`t13-metamask-claim-${id}-2026-10-22.json`,{checkedAt:new Date().toISOString(),chainId:11155111,transaction,receipt,canonicalBlockHash:block.hash,claimedWei:String(amount),gasFeeWei,transferVerified:true});
 Object.assign(account,{grossExitValueWei:String(gross),exitFeeWei:String(exitFee),claimTransaction:log.transactionHash,amountReturnedWei:String(amount),netChangeVsDepositWei:String(amount-BigInt(account.depositWei))});
 gas.push({action:`claim #${id}`,transactionHash:log.transactionHash,gasUsed:String(BigInt(receipt.gasUsed)),effectiveGasPriceWei:String(BigInt(receipt.effectiveGasPrice)),feeWei:gasFeeWei});
}
// Recheck every successful user transaction in the round trip, including exact approvals.
for(const [name,key,action] of [
 ['t13-metamask-approval-2026-10-18.json','receipt','approve #3'],
 ['t13-metamask-entry-success-2026-10-18.json','receipt','enter #3'],
 ['t13-metamask-yin-success-2026-10-18.json','approvalReceipt','approve #4'],
 ['t13-metamask-yin-success-2026-10-18.json','receipt','enter #4'],
 ['t13-metamask-exit-3-2026-10-20.json','receipt','request exit #3'],
 ['t13-metamask-exit-4-2026-10-20.json','receipt','request exit #4'],
]){
 const stored=load(name)[key], r=await historical('eth_getTransactionReceipt',[stored.transactionHash]);
 assert.equal(r.status,'0x1');assert.equal(r.blockHash,(await historical('eth_getBlockByNumber',[r.blockNumber,false])).hash);
 assert.equal(r.blockHash,stored.blockHash);
 gas.push({action,transactionHash:r.transactionHash,gasUsed:String(BigInt(r.gasUsed)),effectiveGasPriceWei:String(BigInt(r.effectiveGasPrice)),feeWei:String(BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice))});
}
const block=await rpc('eth_getBlockByNumber',['latest',false]);
const read=(to,data)=>rpc('eth_call',[{to,data},block.number]);
const balance=a=>read(weth,sel('balanceOf(address)')+a.slice(2).padStart(64,'0')).then(BigInt);
const returned=ledger.accounts.reduce((s,a)=>s+BigInt(a.amountReturnedWei),0n);
assert.equal(returned,19880180000000n);
const walletBalance=await balance(owner), poolBalance=await balance(pool);
assert.equal(walletBalance-BigInt(pre.walletWethWei),returned);
const accounting={};
for(const sig of ['openAccounts()','reservedClaims()','pendingPrincipal()','refundReserve()','buffer()','badDebt()','settling()','insolvent()'])accounting[sig]=String(BigInt(await read(pool,sel(sig))));
for(const value of Object.values(accounting))assert.equal(value,'0');
for(const id of [3,4])assert.equal((await read(pool,sel('accounts(uint256)')+uint(id))).slice(2,66),'0'.repeat(64),'account must be closed');
assert.ok(poolBalance<=1n,'unexpected residual pool funds');
assert.equal((await rpc('eth_getBlockByNumber',[block.number,false])).hash,block.hash);
const sum=key=>ledger.accounts.reduce((s,a)=>s+BigInt(a[key]),0n);
Object.assign(ledger,{checkedAt:new Date().toISOString(),status:'PASS_REAL_WALLET_ROUNDTRIP',totalReturnedWei:String(returned),totalGrossExitValueWei:String(sum('grossExitValueWei')),totalExitFeesWei:String(sum('exitFeeWei')),totalProtocolFeesWei:String(sum('entryFeeWei')+sum('exitFeeWei')),roundingLossWei:String(BigInt(ledger.totalPrincipalWei)-sum('grossExitValueWei')),netChangeVsDepositsWei:String(returned-BigInt(ledger.totalDepositedWei)),snapshotFile:'t13-wallet-postclaim-2026-10-22.json',gasTransactions:gas,totalSuccessfulUserGasFeeWei:String(gas.reduce((s,t)=>s+BigInt(t.feeWei),0n)),remainingChecks:[],scope:'Two authorized Sepolia positions only. ETH gas is separate from WETH returns. Gas total covers eight successful user approvals/entry/exit/claim transactions; excludes previous failed attempts, funding, wrapping and keeper costs. No claim about mainnet readiness, all UI paths, independent audit or profitability.'});
save('t13-wallet-postclaim-2026-10-22.json',{checkedAt:ledger.checkedAt,status:'PASS',chainId:11155111,pool,owner,evmBlock:block.number,evmBlockHash:block.hash,walletWethWei:String(walletBalance),poolWethWei:String(poolBalance),accounting,closedAccounts:[3,4]});
save('t13-roundtrip-ledger-2026-10-22.json',ledger);
console.log(JSON.stringify(ledger,null,2));
