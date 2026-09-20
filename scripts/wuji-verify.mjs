// Independent index reconstruction. Node >=18 only; never reads an indexer or its cache.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
import {SELECTORS} from './compare-chains.mjs';

export const VERIFY_SELECTORS={...SELECTORS,checkpointS:'0x245bc84c',checkpointed:'0x79a2496a',next:'0xd5e4dfa3',bestHeight:'0x8cef3d2a'};
export const DEFAULT_SOURCES=['https://mempool.space/api','https://blockstream.info/api'];
const UNIT=12000000000000n, ZERO='0x'+'0'.repeat(64);
const word=n=>BigInt(n).toString(16).padStart(64,'0');
const sha=b=>createHash('sha256').update(b).digest();
// Deliberately independent of indexer/bitcoin.mjs, including the byte-order conversion.
export function decodeHeader(hex){
 assert.match(hex,/^[0-9a-fA-F]{160}$/,'invalid raw 80-byte header');
 const bytes=Buffer.from(hex,'hex'),hash=sha(sha(bytes)),random=sha(hash);
 return {raw:hex.toLowerCase(),internal:'0x'+hash.toString('hex'),display:Buffer.from(hash).reverse().toString('hex'),parent:'0x'+bytes.subarray(4,36).toString('hex'),delta:BigInt([...random].reduce((a,b)=>a+b,0)-4080)};
}
export async function verifyIndex(manifest,{sources=DEFAULT_SOURCES,fetcher=fetch,rpcUrl=manifest.rpc,concurrency=4,onCheck=()=>{},attempts=3,requestDelayMs=1000}={}){
 assert.equal(manifest.status,'confirmed','deployment not confirmed');
 assert.equal(sources.length,2,'exactly two Bitcoin sources required');
 assert.ok(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=8,'concurrency must be 1..8');
 assert.ok(Number.isInteger(attempts)&&attempts>=1&&attempts<=5,'attempts must be 1..5');
 assert.ok(Number.isFinite(requestDelayMs)&&requestDelayMs>=0,'invalid request delay');
 const urls=sources.map(s=>{const u=new URL(s);assert.ok(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash,'use a plain HTTP(S) Esplora base URL');return u.href.replace(/\/$/,'');});
 assert.notEqual(new URL(urls[0]).hostname,new URL(urls[1]).hostname,'sources must use distinct hosts (choose independent operators)');
 const rpc=(method,params)=>rpcRequest(rpcUrl,method,params,{fetcher,attempts});
 assert.equal(BigInt(await rpc('eth_chainId',[])),BigInt(manifest.chainId),'wrong settlement chain');
 const block=await rpc('eth_getBlockByNumber',['latest',false]);assert.ok(block?.hash&&block.number,'missing EVM observation block');
 const read=async(to,name,arg='')=>{
  const r=await rpc('eth_call',[{to,data:VERIFY_SELECTORS[name]+arg},block.number]);
  assert.match(r,/^0x[0-9a-fA-F]{64}$/,'invalid '+name+' result');return r.toLowerCase();
 };
 const names=['genesis','confirmations','interval','unit','lastHeight','lastHash','S','relay','next','fresh'];
 const r=Object.fromEntries(await Promise.all(names.map(async n=>[n,await read(manifest.WujiIndex,n)])));
 const integer=(v,label)=>{const n=Number(BigInt(v));assert.ok(Number.isSafeInteger(n)&&n>=0,label+' outside safe height range');return n;};
 const genesis=integer(r.genesis,'genesis'),last=integer(r.lastHeight,'lastHeight'),interval=integer(r.interval,'interval');
 assert.equal(genesis,manifest.genesisHeight,'manifest genesis mismatch');assert.ok(genesis>0&&interval>0&&last>=genesis-1,'invalid index range');
 assert.equal(BigInt(r.unit),UNIT,'unexpected UNIT');assert.equal(BigInt(r.confirmations),6n,'unexpected confirmations');
 if(manifest.checkpointInterval!==undefined)assert.equal(interval,manifest.checkpointInterval,'manifest interval mismatch');
 const relay='0x'+r.relay.slice(-40);assert.equal(relay,manifest.BitcoinRelay.toLowerCase(),'relay binding mismatch');
 const [cp,cpHash,best]=await Promise.all(['checkpointHeight','checkpointHash','bestHeight'].map(n=>read(relay,n)));
 const anchor=integer(cp,'anchor'),bestHeight=integer(best,'bestHeight');assert.ok(anchor<=genesis,'anchor after genesis');
 const end=last+6;assert.ok(Number.isSafeInteger(end),'confirmation height overflow');
 if(last>=genesis){
  assert.ok(bestHeight>=end,'relay lacks six descendants');assert.notEqual(r.lastHash,ZERO,'missing folded hash');
  assert.equal(await read(relay,'headerAt',word(last)),r.lastHash,'frozen: folded hash left relay chain');
 }else {assert.equal(BigInt(r.S),0n,'nonzero bootstrap S');assert.equal(r.lastHash,ZERO,'nonzero bootstrap hash');}
 const nextRequest=new Map();
 const get=async(base,route)=>{
  for(let attempt=0;attempt<attempts;attempt++){
   try{const slot=Math.max(Date.now(),nextRequest.get(base)||0);const spacing=new URL(base).hostname==='blockstream.info'?Math.max(6000,requestDelayMs):requestDelayMs;
    nextRequest.set(base,slot+spacing);
    if(slot>Date.now())await new Promise(r=>setTimeout(r,slot-Date.now()));
    const response=await fetcher(base+route,{signal:AbortSignal.timeout(20000)});
    if(!response.ok){const e=Error(`HTTP ${response.status}`);e.retryable=response.status===429||response.status>=500;
     const retryAfter=response.headers?.get('retry-after');
     e.delay=retryAfter?(Number.isFinite(Number(retryAfter))?Number(retryAfter)*1000:Date.parse(retryAfter)-Date.now()):(response.status===429?10000:1000);throw e;}
    return (await response.text()).trim();
   }catch(e){if(e.retryable===false||attempt+1===attempts)throw Error(`Bitcoin source ${base}: ${e.message}`);await new Promise(r=>setTimeout(r,Math.max(e.delay||1000,1000)*(attempt+1)));}
  }
  throw Error('attempts must be positive');
 };
 const hashAt=async(base,h)=>{const hash=await get(base,'/block-height/'+h);assert.match(hash,/^[0-9a-fA-F]{64}$/,'invalid source hash');return hash.toLowerCase();};
 const headerAt=async(base,h)=>{
  const hash=await hashAt(base,h),header=decodeHeader(await get(base,'/block/'+hash+'/header'));
  assert.equal(header.display,hash,`source header/hash mismatch at ${h}`);return header;
 };
 const agreed=async h=>{
  const results=await Promise.allSettled(urls.map(u=>headerAt(u,h)));
  for(const result of results)if(result.status==='rejected')throw result.reason;
  const [a,b]=results.map(r=>r.value);assert.equal(a.raw,b.raw,`Bitcoin sources disagree at ${h}`);return a;
 };
 const anchorHeader=await agreed(anchor);assert.equal(anchorHeader.internal,cpHash,'Bitcoin sources disagree with trusted relay anchor');
 const stableEvm=async()=>assert.equal((await rpc('eth_getBlockByNumber',[block.number,false]))?.hash,block.hash,'EVM observation block reorged; retry');
 const common={checkedAt:new Date().toISOString(),chainId:manifest.chainId,index:manifest.WujiIndex,evmBlock:integer(block.number,'EVM block'),evmBlockHash:block.hash,sources:urls,genesisHeight:genesis,anchorHeight:anchor,anchorHash:cpHash,lastHeight:last,relayHeight:bestHeight,relayFresh:BigInt(r.fresh)===1n,checkpointInterval:interval};
 if(last<genesis){await stableEvm();return {...common,status:'WAIT',reason:'Index has not folded its first height',checkpoints:[]};}
 const checkpoints=[];let U=0n,previous=anchorHeader.internal,finalDisplay=anchorHeader.display,foldedHash;
 const inspect=async(h,b)=>{
  if(h>anchor)assert.equal(b.parent,previous,`broken Bitcoin linkage at ${h}`);
  previous=b.internal;finalDisplay=b.display;
  if(h>=genesis&&h<=last){
   U+=b.delta;
   if((h-genesis+1)%interval===0){
    const [exists,value]=await Promise.all([read(manifest.WujiIndex,'checkpointed',word(h)),read(manifest.WujiIndex,'checkpointS',word(h))]);
    const actual=BigInt.asIntN(256,BigInt(value)),expected=U*UNIT;
    const check={height:h,status:BigInt(exists)===1n&&actual===expected?'PASS':'FAIL',exists:BigInt(exists)===1n,S_wad:actual.toString(),recomputed_S_wad:expected.toString()};
    checkpoints.push(check);onCheck(check);assert.equal(check.status,'PASS',`checkpoint mismatch at ${h}`);
   }
   if(h===last)foldedHash=b.internal;
  }
 };
 if(anchor===genesis)await inspect(anchor,anchorHeader);
 for(let start=anchor+1;start<=end;start+=concurrency){
  const heights=Array.from({length:Math.min(concurrency,end-start+1)},(_,i)=>start+i);
  const batch=await Promise.allSettled(heights.map(agreed));
  for(let i=0;i<batch.length;i++){if(batch[i].status==='rejected')throw batch[i].reason;await inspect(heights[i],batch[i].value);}
 }
 assert.equal(foldedHash,r.lastHash,'reconstructed folded hash differs from contract');
 assert.equal(await read(relay,'headerAt',word(end)),previous,'six descendants differ from relay chain');
 for(const u of urls)assert.equal(await hashAt(u,end),finalDisplay,'Bitcoin source view changed during verification; retry');
 const expected=U*UNIT,actual=BigInt.asIntN(256,BigInt(r.S));
 assert.equal(actual,expected,'final integer S mismatch');
 assert.equal(BigInt(r.next),BigInt(genesis)+(BigInt(Math.floor((last-genesis+1)/interval))+1n)*BigInt(interval)-1n,'next checkpoint mismatch');
 await stableEvm();
 return {...common,status:'PASS',headersRecomputed:last-genesis+1,confirmedThrough:end,lastHash:foldedHash,U:U.toString(),S_wad:actual.toString(),checkpoints,nextCheckpointHeight:Number(BigInt(r.next)),scope:'Exact two-source header agreement, linkage and index/checkpoint arithmetic at this EVM snapshot. RPC responses, the trusted anchor and source operators remain trust assumptions; this is not a full Bitcoin consensus verifier, global synchronization proof or contract audit.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
 let result;
 try{
  const manifest=JSON.parse(fs.readFileSync(process.argv[2]||'contracts/deployments/sepolia-weth-v3.json','utf8'));
  result=await verifyIndex(manifest,{rpcUrl:process.env.READ_RPC||manifest.rpc,sources:process.env.VERIFY_BITCOIN_SOURCES?.split(',')||DEFAULT_SOURCES,onCheck:c=>console.error(`${c.status} checkpoint ${c.height}: ${c.S_wad}`)});
  if(result.status!=='PASS')process.exitCode=2;
 }catch(e){result={status:'FAIL',checkedAt:new Date().toISOString(),reason:e.message};process.exitCode=1;}
 const output=JSON.stringify(result,null,2)+'\n';process.stdout.write(output);
 if(process.env.VERIFY_OUTPUT)fs.writeFileSync(process.env.VERIFY_OUTPUT,output);
}
