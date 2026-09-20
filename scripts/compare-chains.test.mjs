import test from 'node:test';
import assert from 'node:assert/strict';
import {compareChains,increment,SELECTORS} from './compare-chains.mjs';
const word=n=>'0x'+BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0');
const index='0x'+'11'.repeat(20),relay='0x'+'22'.repeat(20);
const hashes=Array.from({length:12},(_,i)=>word(i+100)),unit=12000000000000n;
function fixture({lag=0,wrongS=false,fork=false,genesis=10,rpcChain=11155111,reorg=false}={}){
 const manifests=[97,11155111].map(chainId=>({chainId,status:'confirmed',rpc:String(chainId),genesisHeight:10,WujiIndex:index,BitcoinRelay:relay}));
 const fetcher=async(url,options)=>{
  const {method,params}=JSON.parse(options.body),second=url==='11155111',last=second?12-lag:12;
  const S=[10,11,12].filter(h=>h<=last).reduce((s,h)=>s+increment(hashes[h-9],unit),0n)+(second&&wrongS?1n:0n);
  let result;
  if(method==='eth_chainId')result=word(second?rpcChain:97);
  if(method==='eth_getBlockByNumber')result={number:'0x42',hash:word(reorg&&params[0]!=='latest'?43:42)};
  if(method==='eth_call'){
   assert.equal(params[1],'0x42','every eth_call must be pinned');
   const data=params[0].data,name=Object.keys(SELECTORS).find(k=>SELECTORS[k]===data.slice(0,10));
   const values={S:word(S),lastHeight:word(last),lastHash:last<10?word(0):hashes[last-9],genesis:word(second?genesis:10),confirmations:word(6),interval:word(4320),unit:word(unit),relay:word(BigInt(relay)),fresh:word(1),checkpointHeight:word(9),checkpointHash:hashes[0],chainWork:word(999)};
   result=name==='headerAt'?(second&&fork?word(123456):hashes[Number(BigInt('0x'+data.slice(10)))-9]):values[name];
   assert.ok(result,'unexpected call '+data);
  }
  return {ok:true,json:async()=>({result})};
 };
 return {manifests,fetcher};
}
test('equal-height chain state agrees exactly',async()=>{const f=fixture();const r=await compareChains(f.manifests,f);assert.equal(r.status,'PASS');assert.equal(r.height,12);assert.equal(r.chains[0].atHeight.method,'direct');});
test('reverse only faster-chain increments, retaining signed integer equality',async()=>{const f=fixture({lag:2});const r=await compareChains(f.manifests,f);assert.equal(r.height,10);assert.equal(r.chains[0].atHeight.subtractedHeights,2);assert.equal(r.chains[0].atHeight.S_wad,r.chains[1].S_wad);});
test('empty deployments are WAIT, never a successful comparison',async()=>{const f=fixture({lag:3});assert.equal((await compareChains(f.manifests,f)).status,'WAIT');});
for(const [options,message] of [[{wrongS:true},/integer S disagrees/],[{fork:true},/frozen/],[{genesis:11},/genesis mismatch/],[{rpcChain:1},/chain mismatch/],[{reorg:true},/observation block reorged/]])test('reject '+message,async()=>{const f=fixture(options);await assert.rejects(compareChains(f.manifests,f),message);});
test('large catch-up gaps stop before unbounded RPC work',async()=>{const f=fixture({lag:2});await assert.rejects(compareChains(f.manifests,{...f,maxBacktrack:1}),/height gap/);});
