import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {verifyIndex,decodeHeader,VERIFY_SELECTORS} from './wuji-verify.mjs';
import {step} from '../indexer/bitcoin.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin.json',import.meta.url)));
const headers=fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin-798336.hex',import.meta.url),'utf8').trim().replace(/^0x/,'').match(/.{160}/g);
const index='0x'+'11'.repeat(20),relay='0x'+'22'.repeat(20),ZERO='0x'+'0'.repeat(64);
const word=n=>'0x'+BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0');
function mock({count=20,interval=10,wrongS=false,wrongCheckpoint=false,missing=false,sourceFailure=false,badHeader=false,sourceFork=false,brokenLink=false,changedView=false,reorg=false,frozen=false,wrongChain=false}={}){
 const genesis=fixture.start,last=genesis+count-1,end=last+6,rows=new Map(),sums=new Map();
 let sum=0n;
 for(let h=genesis-1;h<=Math.max(end,genesis-1);h++){
  let raw=h===genesis-1?fixture.checkpointHeader:headers[h-genesis];
  if(brokenLink&&h===genesis+1)raw=raw.slice(0,8)+'00'.repeat(32)+raw.slice(72);
  const s=step(raw);rows.set(h,{raw,...s});
  if(h>=genesis)sum+=BigInt(s.S_wad);sums.set(h,sum);
 }
 const byHash=new Map([...rows.values()].map(r=>[r.hash,r.raw]));let endReads=0;
 const manifest={status:'confirmed',chainId:11155111,rpc:'https://evm.example',genesisHeight:genesis,checkpointInterval:interval,WujiIndex:index,BitcoinRelay:relay};
 const fetcher=async(url,options)=>{
  if(url===manifest.rpc){
   const {method,params}=JSON.parse(options.body);let result;
   if(method==='eth_chainId')result=word(wrongChain?1:11155111);
   if(method==='eth_getBlockByNumber')result={number:'0x42',hash:word(reorg&&params[0]!=='latest'?43:42)};
   if(method==='eth_call'){
    assert.equal(params[1],'0x42','pin every read to observation block');
    const data=params[0].data,name=Object.keys(VERIFY_SELECTORS).find(k=>VERIFY_SELECTORS[k]===data.slice(0,10));
    const h=data.length>10?Number(BigInt('0x'+data.slice(10))):0;
    const values={S:word((sums.get(last)||0n)+(wrongS?1n:0n)),lastHeight:word(last),lastHash:count?'0x'+rows.get(last).internalHash:ZERO,genesis:word(genesis),confirmations:word(6),interval:word(interval),unit:word(12000000000000n),relay:word(BigInt(relay)),fresh:word(1),checkpointHeight:word(genesis-1),checkpointHash:'0x'+rows.get(genesis-1).internalHash,bestHeight:word(end),next:word(genesis+(Math.floor(count/interval)+1)*interval-1)};
    result=name==='headerAt'?(frozen?word(99):'0x'+rows.get(h).internalHash):name==='checkpointed'?word(missing?0:1):name==='checkpointS'?word(sums.get(h)+(wrongCheckpoint?1n:0n)):values[name];
    assert.ok(result,'unexpected '+name);
   }
   return {ok:true,json:async()=>({result})};
  }
  const u=new URL(url),second=u.hostname==='two.example';
  if(sourceFailure&&second)throw Error('offline');
  let text;
  if(u.pathname.startsWith('/block-height/')){
   const h=Number(u.pathname.split('/').at(-1));text=rows.get(h).hash;
   if(h===end&&++endReads>2&&changedView)text='ee'.repeat(32);
   if(second&&sourceFork&&h===genesis){const fork=rows.get(h).raw.slice(0,-8)+'00000000';text=step(fork).hash;byHash.set(text,fork);}
  }else {const hash=u.pathname.split('/')[2];text=byHash.get(hash);if(second&&badHeader)text=text.slice(0,-1)+'z';}
  assert.ok(text,'unknown fixture URL '+url);return {ok:true,text:async()=>text};
 };
 return {manifest,fetcher,sources:['https://one.example','https://two.example'],attempts:1,requestDelayMs:0};
}
const run=f=>verifyIndex(f.manifest,f);
test('two sources, real headers across a retarget, every checkpoint and final signed S',async()=>{
 const f=mock({count:2022,interval:1008}),checks=[];const r=await verifyIndex(f.manifest,{...f,onCheck:c=>checks.push(c)});
 assert.equal(r.status,'PASS');assert.equal(r.headersRecomputed,2022);assert.equal(checks.length,2);assert.ok(checks.every(c=>c.status==='PASS'));
 assert.equal(r.S_wad,headers.slice(0,2022).reduce((v,h)=>v+BigInt(step(h).S_wad),0n).toString());
});
test('known block 800000 fixes raw digest byte order',()=>{
 const d=decodeHeader(headers[800000-fixture.start]);assert.equal(d.internal.slice(2),fixture.known800000.internalHash);assert.equal(d.display,fixture.known800000.hash);assert.equal(d.delta,-187n);
});
test('empty index is WAIT, never a reconstruction PASS',async()=>assert.equal((await run(mock({count:0}))).status,'WAIT'));
for(const [opts,message] of [[{wrongS:true},/final integer S/],[{wrongCheckpoint:true},/checkpoint mismatch/],[{missing:true},/checkpoint mismatch/],[{sourceFailure:true},/offline/],[{badHeader:true},/invalid raw/],[{sourceFork:true},/sources disagree/],[{brokenLink:true},/broken Bitcoin linkage/],[{changedView:true},/source view changed/],[{reorg:true},/EVM observation block reorged/],[{frozen:true},/frozen/],[{wrongChain:true},/wrong settlement chain/]]){
 test('reject '+message,async()=>await assert.rejects(run(mock(opts)),message));
}
test('a failed checkpoint is explicitly reported before overall failure',async()=>{
 const f=mock({wrongCheckpoint:true}),checks=[];await assert.rejects(verifyIndex(f.manifest,{...f,onCheck:c=>checks.push(c)}));assert.equal(checks[0].status,'FAIL');
});
test('same host cannot masquerade as two sources',async()=>{const f=mock();f.sources=['https://one.example/a','https://one.example/b'];await assert.rejects(run(f),/distinct hosts/);});
