// Record the one user-confirmed entry during cancellation acceptance; read-only, never retries it.
import fs from 'node:fs';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import {rpcRequest} from '../indexer/evm-rpc.mjs';import {readAccount} from '../indexer/accounts.mjs';
const pre=JSON.parse(fs.readFileSync('operator/sepolia-header-v3/wallet-ui-2026-10-22/before.json'));
const rpc=(m,p)=>rpcRequest('https://ethereum-sepolia-rpc.publicnode.com',m,p),word=a=>'0x'+a.slice(2).padStart(64,'0');
assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
const topic=execFileSync('/Users/m/.foundry/bin/cast',['keccak','EnterRequested(uint256,address,bool,uint128,uint64)'],{encoding:'utf8'}).trim();
const logs=await rpc('eth_getLogs',[{address:pre.pool,fromBlock:pre.block,toBlock:'latest',topics:[topic,null,word(pre.owner)]}]);
assert.equal(logs.length,1,'expected exactly one entry, inspect any different count');const log=logs[0];assert.equal(BigInt(log.topics[1]),5n);
const [transaction,receipt]=await Promise.all([rpc('eth_getTransactionByHash',[log.transactionHash]),rpc('eth_getTransactionReceipt',[log.transactionHash])]);
assert.equal(receipt.status,'0x1');assert.equal(transaction.from.toLowerCase(),pre.owner);
assert.equal((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false])).hash,receipt.blockHash);
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const transfers=receipt.logs.filter(l=>l.address.toLowerCase()===pre.asset&&l.topics[0]===transfer&&l.topics[1]===word(pre.owner)&&l.topics[2]===word(pre.pool));assert.equal(transfers.length,1);assert.equal(BigInt(transfers[0].data),1000000000000n);
const block=await rpc('eth_getBlockByNumber',['latest',false]);const account=await readAccount((to,data)=>rpc('eth_call',[{to,data},block.number]),pre.pool,5);
assert.equal(account.owner,pre.owner);assert.equal(account.principal_wad,'997000000000');
assert.equal((await rpc('eth_getBlockByNumber',[block.number,false])).hash,block.hash);
const result={at:new Date().toISOString(),status:'ENTRY_CONFIRMED_NOT_REJECTION',chainId:11155111,owner:pre.owner,pool:pre.pool,depositWei:'1000000000000',entryFeeWei:'3000000000',principalWei:'997000000000',transaction,receipt,gasFeeWei:(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)).toString(),account,canonicalBlockHash:receipt.blockHash,postBlock:block.number,postBlockHash:block.hash,scope:'User reported confirming instead of rejecting. One new pending entry must be tracked through exit/claim; not a cancellation or first type-4 pass.'};
fs.writeFileSync('contracts/deployments/t13-wallet-ui-entry-5-2026-10-22.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({hash:transaction.hash,type:transaction.type,status:receipt.status,account},null,2));
