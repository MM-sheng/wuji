// Exercise the actual v3 wallet handlers with a deterministic EIP-1193 provider.
import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  const PERP_TOPIC='),html.indexOf("  $('pjPool').onchange="));
const prelude=html.slice(html.indexOf('  const W={acct:'),html.indexOf('  async function refreshWallet('));
const amount=html.slice(html.indexOf('  function exactAmount('),html.indexOf('  // ---------------------------------------------------------------- ZK index'));
const registry=JSON.parse(html.match(/  const PERP_RELEASES=(.+);/)[1]);
const owner='0x'+'aa'.repeat(20),hash='0x'+'bb'.repeat(32),w=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
function fixture(options={}){
 const rel={...registry[0],...registry[0].accountPools[1]},calls=[],sent=[],nodes=new Map();
 const get=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='pjPool'?rel.address:id==='pjAmt'?(options.amount??'0.00001'):id==='pjId'?'1':'',innerHTML:'',textContent:''});return nodes.get(id);};
 let ctx,chain=options.chain??11155111;
 const provider={request:async({method,params})=>{
  calls.push({method,params});
  if(method==='eth_chainId')return '0x'+chain.toString(16);
  if(method==='eth_accounts')return [owner];
  if(method==='eth_getBlockByNumber')return {number:'0x64',hash:params[0]!=='latest'&&options.reorg?w(2):w(1),timestamp:'0x'+(Math.floor(Date.now()/1000)-(options.stale?300:1)).toString(16)};
  if(method==='eth_getCode')return params[0]===owner?(options.delegated?'0xef0100'+'12'.repeat(20):'0x'):(options.badCode?'0x6002':'0x6001');
  if(method==='eth_estimateGas')return '0x'+BigInt(options.gasEstimate??1118574).toString(16);
  if(method==='eth_call'){
   const {to,data,from}=params[0],sig=data.slice(0,10);
   if(from){if(options.revert)throw Error('execution reverted: '+options.revert);return '0x';}
   if(to.toLowerCase()===rel.asset.toLowerCase())return sig==='0x70a08231'?w(options.balance??100000000000000n):w(0);
   const map={'0x38d52e0f':w(rel.asset),'0xa932492f':w(rel.k_wad),'0x2986c0e5':w(options.badIndex?'0x'+'12'.repeat(20):rel.index),
    '0xbf333f2c':w(rel.feeBps),'0x61d027b3':w(rel.treasury),'0x0438b0a4':w(100),'0xda980340':w(options.accepting===false?0:1)};
   assert.ok(map[sig],'unexpected call '+sig);return map[sig];
  }
  if(method==='eth_sendTransaction'){
   if(options.reject)throw {code:4001,message:'User rejected transaction'};
   sent.push(params[0]);
   if(options.changeAccount)ctx.api.W.acct='0x'+'dd'.repeat(20);
   if(options.changeChain)chain=97;
   return hash;
  }
  if(method==='eth_getTransactionReceipt')return {status:'0x1',logs:[],transactionHash:hash};
  throw Error('unexpected method '+method);
 }};
 ctx=vm.createContext({window:{ethereum:provider},crypto:webcrypto,Date,Uint8Array,TextDecoder,setTimeout,RELEASES:{},
  WORD:/^0x[0-9a-f]{64}$/i,word:h=>{assert.match(h,/^0x[0-9a-f]{64}$/i);return BigInt(h);},addressWord:h=>'0x'+h.slice(-40),
  same:(a,b)=>String(a).toLowerCase()===String(b).toLowerCase(),$:get,short:x=>x,esc:x=>x,fmtW:x=>String(BigInt(x)/10n**18n),
  confirm:()=>true,lookAccount:()=>{},localStorage:{getItem:()=>null,setItem:()=>{}},renderWallet:()=>{}});
 vm.runInContext(prelude+amount+code+'\nrenderPerpWallet=()=>{}; W.acct="'+owner+'";this.api={W,perpForm,perpEnter,perpAction,perpSend,verifyPerpRelease,releasedPool,PERP_RELEASES};',ctx);
 const sha=createHash('sha256').update(Buffer.from('6001','hex')).digest('hex');
 ctx.api.PERP_RELEASES[0].indexCodeSha256=sha;for(const p of ctx.api.PERP_RELEASES[0].accountPools)p.codeSha256=sha;
 return {...ctx.api,get,calls,sent,rel:ctx.api.releasedPool(rel.address)};
}
test('v3 registry contains exactly the deployed pools, index and fee router',()=>{
 const j=JSON.parse(fs.readFileSync(new URL('../../contracts/deployments/sepolia-header-v3.json',import.meta.url)));
 assert.deepEqual(registry[0].accountPools.map(p=>p.address),j.accounts.pools.map(p=>p.address));
 assert.equal(registry[0].index,j.WujiHeaderIndex);assert.equal(registry[0].treasury,j.FeeRouter);
 assert.equal(registry[0].confirmations,100);assert.ok(registry[0].accountPools.every(p=>/^[0-9a-f]{64}$/.test(p.codeSha256)));
});
test('successful entry sends exact approval then chain-bound enter and pins verification reads',async()=>{
 const f=fixture();await f.perpEnter();assert.equal(f.sent.length,2);
 assert.equal(f.sent[0].data,'0x095ea7b3'+f.rel.address.slice(2).padStart(64,'0')+w(10000000000000n).slice(2));
 assert.equal(f.sent[1].data.slice(0,10),'0x94386983');assert.equal(f.sent[1].chainId,'0xaa36a7');
 assert.ok(f.calls.filter(c=>c.method==='eth_getCode'&&c.params[0]!==owner).every(c=>c.params[1]==='0x64'));
 assert.equal(BigInt(f.sent[1].gas),1398218n);
 assert.equal(f.perpForm.busy,false);assert.equal(f.perpForm.flowBusy,false);
});
for(const amount of ['0','abc','-1'])test('invalid amount '+amount+' never requests a signature',async()=>{const f=fixture({amount});await f.perpEnter();assert.equal(f.sent.length,0);assert.match(f.perpForm.msg,/数量|输入/);});
for(const [options,error] of [[{balance:0n},/余额不足/],[{chain:97},/切换/],[{stale:true},/过期/],
 [{reorg:true},/链重组/],[{badCode:true},/代码/],[{badIndex:true},/绑定/],[{accepting:false},/不接受/]])
 test('preflight blocks '+JSON.stringify(options,(_,v)=>typeof v==='bigint'?String(v):v),async()=>{const f=fixture(options);await f.perpEnter();assert.equal(f.sent.length,0);assert.match(f.perpForm.msg,error);assert.equal(f.perpForm.flowBusy,false);});
test('signature rejection stops entry and clears busy state',async()=>{const f=fixture({reject:true});await f.perpEnter();assert.equal(f.sent.length,0);assert.match(f.perpForm.msg,/已在钱包中取消/);assert.equal(f.perpForm.busy,false);assert.equal(f.perpForm.flowBusy,false);});
for(const change of ['changeAccount','changeChain'])test(change+' after approval prevents entry',async()=>{const f=fixture({[change]:true});await f.perpEnter();assert.equal(f.sent.length,1);assert.match(f.perpForm.msg,/改变|切换/);});
for(const reason of ['not claimable','exit pending','not owner','settlement pending'])test(reason+' is simulated before any signature',async()=>{
 const f=fixture({revert:reason});await f.perpAction(reason==='exit pending'?'exit':'claim');assert.equal(f.sent.length,0);assert.match(f.perpForm.msg,/还不能领取|已经申请|不属于|分批结算/);assert.equal(f.perpForm.busy,false);
});
test('exit and claim use the selected account id on the released pool',async()=>{
 const f=fixture();f.get('pjId').value='2';await f.perpAction('exit');await f.perpAction('claim');assert.equal(f.sent.length,2);
 assert.equal(f.sent[0].data,'0x721c6513'+w(2).slice(2));assert.equal(f.sent[1].data,'0x379607f5'+w(2).slice(2));
 assert.ok(f.sent.every(t=>t.to===f.rel.address&&t.from===owner));
});
test('unpublished pool remains unable to enter',async()=>{const f=fixture();f.get('pjPool').value='0x'+'99'.repeat(20);await f.perpEnter();assert.equal(f.sent.length,0);});
test('a second click during entry preflight cannot duplicate approvals or entries',async()=>{
 const f=fixture();await Promise.all([f.perpEnter(),f.perpEnter()]);assert.equal(f.sent.length,2);assert.equal(f.perpForm.flowBusy,false);
});

test('delegated wallet gets an explicit budget for wrapper hooks before signing',async()=>{
 const f=fixture({delegated:true});await f.perpEnter();assert.equal(f.sent.length,2);
 assert.ok(f.sent.every(tx=>BigInt(tx.gas)===2737148n));
});
test('unbounded gas estimates stop before wallet submission',async()=>{
 const f=fixture({delegated:true,gasEstimate:3000000});await f.perpEnter();
 assert.equal(f.sent.length,0);assert.match(f.perpForm.msg,/gas.*异常/);assert.equal(f.perpForm.flowBusy,false);
});
