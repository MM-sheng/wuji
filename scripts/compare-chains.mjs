// Compare deployed integer indexes at one Bitcoin height. Reads are pinned to one EVM block per chain.
// Usage: node scripts/compare-chains.mjs [bsc-manifest.json sepolia-manifest.json]
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {sha256} from '../indexer/bitcoin.mjs';
import {assertChain} from '../indexer/networks.mjs';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
export const SELECTORS={S:'0x4be1c796',lastHeight:'0x25159aa9',lastHash:'0x3fa21806',genesis:'0x207c8a4c',confirmations:'0x0438b0a4',interval:'0xead68f82',unit:'0x9d8e2177',relay:'0xb59589d1',checkpointHeight:'0xa71b1dec',checkpointHash:'0x445c79f1',chainWork:'0xc113b9c3',headerAt:'0xec1867e3',fresh:'0x8647058f'};
const ZERO='0x'+'0'.repeat(64);
const word=n=>BigInt(n).toString(16).padStart(64,'0');
export function increment(hash,unit){
 assert.match(hash,/^0x[0-9a-fA-F]{64}$/);
 return BigInt([...sha256(Buffer.from(hash.slice(2),'hex'))].reduce((a,b)=>a+b,0)-4080)*unit;
}
export async function compareChains(manifests,{fetcher=fetch,maxBacktrack=4320}={}){
 assert.equal(manifests.length,2);
 assert.notEqual(manifests[0].chainId,manifests[1].chainId,'use two different settlement chains');
 const views=await Promise.all(manifests.map(async j=>{
  assert.equal(j.status,'confirmed','deployment not confirmed');
  const rpc=(method,params)=>rpcRequest(j.rpc,method,params,{fetcher,timeoutMs:20000});
  assertChain(await rpc('eth_chainId',[]),j.chainId);
  const block=await rpc('eth_getBlockByNumber',['latest',false]);assert.ok(block?.hash,'missing observation block');
  const call=async(to,name,arg='')=>{
   const result=await rpc('eth_call',[{to,data:SELECTORS[name]+arg},block.number]);
   assert.match(result,/^0x[0-9a-fA-F]{64}$/,'missing/invalid contract result');return result.toLowerCase();
  };
  const fields=['S','lastHeight','lastHash','genesis','confirmations','interval','unit','relay','fresh'];
  const r=Object.fromEntries(await Promise.all(fields.map(async name=>[name,await call(j.WujiIndex,name)])));
  const relay='0x'+r.relay.slice(-40);assert.equal(relay,j.BitcoinRelay.toLowerCase(),'relay binding');
  const cpHeight=await call(relay,'checkpointHeight'),cpHash=await call(relay,'checkpointHash'),cpWork=await call(relay,'chainWork',cpHash.slice(2));
  const state={chainId:j.chainId,index:j.WujiIndex,evmBlock:Number(BigInt(block.number)),evmBlockHash:block.hash,lastHeight:Number(BigInt(r.lastHeight)),lastHash:r.lastHash,S:BigInt.asIntN(256,BigInt(r.S)),fresh:BigInt(r.fresh)===1n};
  const params={genesis:Number(BigInt(r.genesis)),confirmations:Number(BigInt(r.confirmations)),interval:Number(BigInt(r.interval)),unit:BigInt(r.unit).toString(),checkpointHeight:Number(BigInt(cpHeight)),checkpointHash:cpHash,checkpointWork:BigInt(cpWork).toString()};
  assert.equal(params.genesis,j.genesisHeight,'manifest genesis mismatch');
  assert.ok(state.lastHeight>=params.genesis-1,'index height before genesis');
  const hashAt=h=>call(relay,'headerAt',word(h));
  if(state.lastHeight>=params.genesis){assert.notEqual(state.lastHash,ZERO);assert.equal(await hashAt(state.lastHeight),state.lastHash,'frozen: folded hash left relay main chain');}
  else {assert.equal(state.S,0n);assert.equal(state.lastHash,ZERO);}
  return {state,params,hashAt,rpc,block};
 }));
 assert.deepEqual(views[0].params,views[1].params,'index parameters or trust anchors differ');
 const params=views[0].params,height=Math.min(...views.map(v=>v.state.lastHeight));
 if(height<params.genesis)return {status:'WAIT',reason:'At least one index has not folded its first height',height,params,chains:views.map(v=>({...v.state,S_wad:v.state.S.toString(),S:undefined}))};
 const chains=await Promise.all(views.map(async v=>{
  const gap=v.state.lastHeight-height;
  assert.ok(gap<=maxBacktrack,`height gap ${gap} exceeds ${maxBacktrack}; let the slower keeper catch up`);
  let value=v.state.S;
  // An immutable folded prefix plus unchanged lastHash authenticates the prefix used here.
  // Reverse only the extra increments on the faster chain; never compare S values from different heights.
  for(let h=height+1;h<=v.state.lastHeight;h++){
   const hash=await v.hashAt(h);assert.notEqual(hash,ZERO,'missing relayed header');value-=increment(hash,BigInt(params.unit));
  }
  const hash=await v.hashAt(height);assert.notEqual(hash,ZERO);
  const stable=await v.rpc('eth_getBlockByNumber',[v.block.number,false]);assert.equal(stable?.hash,v.block.hash,'EVM observation block reorged; retry');
  return {...v.state,S_wad:v.state.S.toString(),S:undefined,atHeight:{height,lastHash:hash,S_wad:value.toString(),method:gap?'subtract-relay-increments':'direct',subtractedHeights:gap}};
 }));
 assert.equal(chains[0].atHeight.lastHash,chains[1].atHeight.lastHash,'Bitcoin hashes disagree');
 assert.equal(chains[0].atHeight.S_wad,chains[1].atHeight.S_wad,'integer S disagrees');
 return {status:'PASS',checkedAt:new Date().toISOString(),height,params,chains,scope:'Same-height index equality under these RPC responses; separate claims, not a bridge or proof of global Bitcoin synchronization.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const files=process.argv.slice(2);if(files.length===0)files.push('contracts/deployments/bsc-testnet-timestamps-v3.json','contracts/deployments/sepolia-weth-v3.json');
  const result=await compareChains(files.map(f=>JSON.parse(fs.readFileSync(f))));
  const output=JSON.stringify(result,null,2)+'\n';console.log(output);
  if(process.env.COMPARISON_OUTPUT)fs.writeFileSync(process.env.COMPARISON_OUTPUT,output);
  if(result.status!=='PASS')process.exitCode=2;
 }catch(e){console.error('FAIL',e.message);process.exitCode=1;}
}
