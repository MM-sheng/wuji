// Execute the actual single-file wallet code with an EIP-1193 test double, without a browser extension.
import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('  const W={acct:'),html.indexOf("  $('wConnect').onclick=connect;"));
function wallet({chain=11155111,approve=false}={}){
 const sent=[],v={address:'0x'+'11'.repeat(20),asset:'0x'+'22'.repeat(20),yang:'0x'+'33'.repeat(20),yin:'0x'+'44'.repeat(20),chainId:11155111,notional:0.001,symbol:'WETH'};
 const provider={request:async({method,params})=>{
  if(method==='eth_chainId')return '0x'+chain.toString(16);
  if(method==='eth_call')return '0x0';
  if(method==='eth_sendTransaction'){sent.push(params[0]);return '0x'+'aa'.repeat(32);}
  if(method==='eth_getTransactionReceipt')return {status:approve?'0x1':'0x0'};
  throw Error('Unexpected wallet method '+method);
 }};
 const ctx=vm.createContext({window:{ethereum:provider},HEAD:{chain:{}},curVault:()=>v,$:()=>({value:'1'}),short:x=>x,setTimeout});
 vm.runInContext(source+'\nrenderWallet=()=>{}; W.acct="0x'+'55'.repeat(20)+'"; W.bal={allow:0};this.api={W,doMint,send,refreshWallet,walletContext,walletNetworks};',ctx);
 return {...ctx.api,sent,v};
}
test('Sepolia has ETH metadata and the correct chain id',()=>{const w=wallet();assert.equal(w.walletNetworks[11155111].chainId,'0xaa36a7');assert.equal(w.walletNetworks[11155111].nativeCurrency.symbol,'ETH');});
test('wrong network cannot send approval or mint',async()=>{const w=wallet({chain:97});await w.doMint();assert.equal(w.sent.length,0);assert.match(w.W.msg,/Switch wallet/);});
test('reverted approval stops mint',async()=>{const w=wallet();await w.doMint();assert.equal(w.sent.length,1);assert.equal(w.sent[0].data.slice(0,10),'0x095ea7b3');assert.match(w.W.msg,/approve WETH/);});
test('successful approval is followed by a chain-bound mint',async()=>{const w=wallet({approve:true});await w.doMint();assert.equal(w.sent.length,2);assert.equal(w.sent[1].data.slice(0,10),'0xa0712d68');assert.equal(w.sent[1].chainId,'0xaa36a7');});
test('account changes between steps abort the transaction',async()=>{const w=wallet({approve:true}),context=w.walletContext(w.v);w.W.acct='0x'+'66'.repeat(20);assert.equal(await w.send(w.v.address,'0x','mint',context),false);assert.equal(w.sent.length,0);});
