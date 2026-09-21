import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {readFrozenExit,exitActionAllowed} from './frozen-exit.mjs';
import {maintainFrozenExit} from './frozen-keeper.mjs';
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),index='0x'+'11'.repeat(20),relay='0x'+'22'.repeat(20),vault='0x'+'33'.repeat(20);
function fixture({frozen=false,consistent=false,ready=false,from=100,deadline=244,best=120,revision=1,noticeRevision=1,canonical=55,closed=false}={}){
 const values={'0x054f7d9c':word(+frozen),'0x68c5cf08':word(+consistent),'0x482c25fd':word(+ready),'0x8dbbb868':word(144),'0xfcbbb8a9':'0x'+[from,deadline,94,44,55,noticeRevision].map(n=>word(n).slice(2)).join(''),'0x12c5c524':word(revision),'0x8cef3d2a':word(best),'0x25159aa9':word(94),'0x3fa21806':word(44),'0xec1867e3':word(canonical),'0xb59589d1':word(relay),'0x597e1fb5':word(+closed),'0x2986c0e5':word(index)};
 const reads=[],sends=[],now=Date.now(),block={number:'0x64',hash:word(99),timestamp:'0x'+Math.floor(now/1000).toString(16)};
 const read=async(to,data)=>{const value=values[data.slice(0,10)];assert.ok(value,'unexpected selector '+data);return value;};
 const rpc=async(method,params)=>{
  if(method==='eth_chainId')return '0xaa36a7';if(method==='eth_getBlockByNumber')return block;
  if(method==='eth_call'){reads.push(params);return read(params[0].to,params[0].data);}throw Error(method);
 };
 return {values,read,reads,sends,block,options:{rpc,index,relay,vaults:()=>[vault],send:async(...a)=>sends.push(a),chainId:11155111,now}};
}
test('browser and backend share exactly the same exit reader and policy',()=>{
 const html=fs.readFileSync(new URL('../apps/terminal/index.html',import.meta.url),'utf8');
 const source=fs.readFileSync(new URL('./frozen-exit.mjs',import.meta.url),'utf8').replaceAll('export ','');
 assert.equal(html.split('  // BEGIN FROZEN EXIT SHARED\n')[1].split('  // END FROZEN EXIT SHARED')[0],source);
});
for(const [name,options,phase,operations] of [
 ['healthy',{consistent:true},'active',[]],['unobserved',{from:0},'unobserved',['observeReorg()']],['waiting',{},'waiting',[]],
 ['changed branch',{revision:2},'unobserved',['observeReorg()']],['wrong ancestor',{canonical:56},'unobserved',['observeReorg()']],
 ['ready',{ready:true,best:244},'ready',['freeze()']],['frozen',{frozen:true,best:244},'frozen',['settleFrozen()']],
 ['closed',{frozen:true,closed:true},'frozen',[]],['restored after sealing',{frozen:true,consistent:true},'frozen',['settleFrozen()']]
])test('exit keeper: '+name,async()=>{
 const f=fixture(options),state=await maintainFrozenExit(f.options);assert.equal(state.phase,phase);assert.deepEqual(f.sends.map(a=>a[1]),operations);
 assert.ok(f.reads.every(a=>a[1]==='0x64'),'every eligibility call is pinned');
});
test('false readiness, wrong binding, stale block, EVM reorg and mainnet cannot send',async()=>{
 for(const kind of ['ready','binding','stale','reorg','mainnet','chain']){
  const f=fixture({ready:kind==='ready'});
  if(kind==='binding')f.values['0xb59589d1']=word(index);
  if(kind==='stale')f.block.timestamp='0x1';
  if(kind==='mainnet')f.options.chainId=1;
  if(kind==='chain')f.options.chainId=97;
  if(kind==='reorg'){const original=f.options.rpc;f.options.rpc=async(m,p)=>m==='eth_getBlockByNumber'&&p[0]!=='latest'?{...f.block,hash:word(98)}:original(m,p);}
  await assert.rejects(maintainFrozenExit(f.options));assert.equal(f.sends.length,0,kind);
 }
});
test('only paired or already-settled claims can exit before sealing',async()=>{
 const f=fixture(),frozenExit=await readFrozenExit(f.read,index,relay),state={frozenExit,closed:false,settled:false};
 assert.equal(exitActionAllowed(state,'pair'),true);assert.equal(exitActionAllowed(state,'settled'),false);assert.equal(exitActionAllowed({...state,settled:true},'settled'),true);
 assert.equal(exitActionAllowed(state,'freeze'),false);assert.equal(exitActionAllowed(state,'close'),false);
 assert.equal(exitActionAllowed({},'pair'),false);
});
test('frozen closing awaits async vault discovery and propagates discovery failures',async()=>{
 const f=fixture({frozen:true});f.options.vaults=async()=>[vault];
 await maintainFrozenExit(f.options);assert.deepEqual(f.sends.map(a=>a[1]),['settleFrozen()']);
 const bad=fixture({frozen:true});bad.options.vaults=async()=>{throw Error('factory unavailable');};
 await assert.rejects(maintainFrozenExit(bad.options),/factory unavailable/);assert.equal(bad.sends.length,0);
});
