// Read-only, resumable full current-deployment verification. All writes are in a fresh isolated directory.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { rpcRequest } from '../indexer/evm-rpc.mjs';
import { sel } from '../indexer/zk-challenge.mjs';
import { digest, encode, replay, decodeContinuity } from './lib/header-verification.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'contracts/deployments/sepolia-header-v3.json')));
const anchor=JSON.parse(fs.readFileSync(path.join(root,manifest.anchor)));
const out=path.resolve(process.argv[2] || '');
assert.ok(process.argv[2] && !fs.existsSync(path.join(out,'result.json')),'supply an isolated output directory without completed result');
assert.ok(![root,path.join(root,'operator/sepolia-header-v3')].includes(out)); fs.mkdirSync(out,{recursive:true});
const write=(name,v)=>fs.writeFileSync(path.join(out,name),JSON.stringify(v,null,2)+'\n');
const rpc=(method,params)=>{assert.ok(['eth_chainId','eth_getBlockByNumber','eth_call'].includes(method));return rpcRequest(manifest.rpc,method,params);};
if(process.env.VERIFY_SNAPSHOT && !fs.existsSync(path.join(out,'snapshot.json'))) {
  const saved=JSON.parse(fs.readFileSync(process.env.VERIFY_SNAPSHOT));write('snapshot.json',saved);
}
let snapshot;
if(fs.existsSync(path.join(out,'snapshot.json')))snapshot=JSON.parse(fs.readFileSync(path.join(out,'snapshot.json')));
else {
  assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
  const block=await rpc('eth_getBlockByNumber',['finalized',false]); assert.ok(block?.hash);
  const signatures=['continuity()','CONFIRMATIONS()','frozen()','seenHeight()','seenTime()','GENESIS_HEIGHT()','CHECKPOINT_INTERVAL()'];
  const reads=await Promise.all(signatures.map(sig=>rpc('eth_call',[{to:manifest.WujiHeaderIndex,data:sel(sig)},block.number])));
  snapshot={observedAt:new Date().toISOString(),index:manifest.WujiHeaderIndex,block,reads:Object.fromEntries(signatures.map((s,i)=>[s,reads[i]])),state:decodeContinuity(reads[0])};
  write('snapshot.json',snapshot);
}
assert.equal(BigInt(await rpc('eth_chainId',[])),11155111n);
assert.equal((await rpc('eth_getBlockByNumber',[snapshot.block.number,false])).hash,snapshot.block.hash);
for(const [sig,value] of Object.entries(snapshot.reads)){assert.equal(await rpc('eth_call',[{to:manifest.WujiHeaderIndex,data:sel(sig)},snapshot.block.number]),value,`saved RPC response differs: ${sig}`);}
assert.deepEqual(decodeContinuity(snapshot.reads['continuity()']),snapshot.state);
assert.equal(snapshot.index,manifest.WujiHeaderIndex); assert.equal(BigInt(snapshot.reads['CONFIRMATIONS()']),100n);
assert.equal(BigInt(snapshot.reads['frozen()']),0n);assert.equal(Number(BigInt(snapshot.reads['CHECKPOINT_INTERVAL()'])),manifest.checkpointInterval); assert.equal(Number(BigInt(snapshot.reads['GENESIS_HEIGHT()'])),anchor.genesisHeight);
const from=anchor.anchorHeight-10, end=snapshot.state.height+100;
const archiveFile=process.env.HEADER_FILE || path.join(root,'operator/sepolia-header-v3/headers/mainnet.bin');
const bytes=fs.readFileSync(archiveFile);
assert.ok(bytes.length>=(end+1)*80,'P2P archive incomplete');
const p2p=bytes.subarray(from*80,(end+1)*80); fs.writeFileSync(path.join(out,'p2p-span.bin'),p2p);
const headers=new Map(); const pages=[];fs.mkdirSync(path.join(out,'http-pages'),{recursive:true});
async function page(height){
  const name=`http-pages/${height}.json`, file=path.join(out,name), url=`https://mempool.space/api/v1/blocks/${height}`;
  let list;
  if(fs.existsSync(file))list=JSON.parse(fs.readFileSync(file));
  else {
    let error;
    for(let attempt=0;attempt<4;attempt++){
      try { const res=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!res.ok){await res.body?.cancel();throw Error(`HTTP ${res.status}`);}list=await res.json();break; }
      catch(e){error=e;if(attempt<3)await new Promise(r=>setTimeout(r,Math.min(30000,2000*2**attempt)));}
    }
    if(!list)throw error;
    assert.ok(Array.isArray(list)&&list.length>0&&list.length<=15);write(name,list);
    await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(list[0].height,height); list.forEach((b,i)=>assert.equal(b.height,height-i));
  for(const b of list){const raw=encode(b);if(b.height>=from&&b.height<=end){if(headers.has(b.height))assert.ok(headers.get(b.height).equals(raw));headers.set(b.height,raw);}}
  pages.push({url,file:name,sha256:digest(fs.readFileSync(file)).toString('hex')});return list;
}
for(let cursor=end;cursor>=from;){const list=await page(cursor);cursor=list.at(-1).height-1;if(pages.length%20===0)console.log(`Second source: ${headers.size}/${end-from+1} headers`);}
assert.equal(headers.size,end-from+1);
const epoch=(await page(anchor.epochFirst))[0]; assert.equal(epoch.timestamp,anchor.epochStart);
assert.ok(encode(epoch).equals(bytes.subarray(anchor.epochFirst*80,(anchor.epochFirst+1)*80)), 'epoch-first source mismatch');
for(let h=from;h<=end;h++)assert.ok(headers.get(h).equals(p2p.subarray((h-from)*80,(h-from+1)*80)),`source mismatch ${h}`);
const http=Buffer.concat(Array.from({length:end-from+1},(_,i)=>headers.get(from+i)));
fs.writeFileSync(path.join(out,'http-span.bin'),http);write('source-pages.json',pages);
const result=replay(headers,anchor,snapshot.state.height,Number(BigInt(snapshot.block.timestamp)));
assert.deepEqual(result.finalized,snapshot.state,'complete continuity differs');
assert.equal(Number(BigInt(snapshot.reads['seenHeight()'])),end);assert.equal(Number(BigInt(snapshot.reads['seenTime()'])),headers.get(end).readUInt32LE(68));
const onchainS=await rpc('eth_call',[{to:manifest.WujiHeaderIndex,data:sel('S()')},snapshot.block.number]);
const unsignedS=BigInt(onchainS), signedS=unsignedS>=(1n<<255n)?unsignedS-(1n<<256n):unsignedS;
assert.equal(signedS.toString(),result.finalized.S_wad,'S view differs');
const checkpoints=[];
for(let h=anchor.genesisHeight+manifest.checkpointInterval-1;h<=snapshot.state.height;h+=manifest.checkpointInterval){
 const partial=replay(headers,anchor,h,Number(BigInt(snapshot.block.timestamp))).finalized;
 const value=await rpc('eth_call',[{to:manifest.WujiHeaderIndex,data:sel('checkpointS(uint64)')+BigInt(h).toString(16).padStart(64,'0')},snapshot.block.number]);
 const v=BigInt(value), signed=v>=(1n<<255n)?v-(1n<<256n):v;assert.equal(signed.toString(),partial.S_wad);checkpoints.push(h);
}
assert.equal((await rpc('eth_getBlockByNumber',[snapshot.block.number,false])).hash,snapshot.block.hash);
write('verified.json',{status:'PASS',observedAt:new Date().toISOString(),chainId:11155111,index:manifest.WujiHeaderIndex,evmBlock:Number(BigInt(snapshot.block.number)),evmBlockHash:snapshot.block.hash,anchorHeight:anchor.anchorHeight,genesisHeight:anchor.genesisHeight,from,to:end,headers:headers.size,p2pSha256:digest(p2p).toString('hex'),httpSha256:digest(http).toString('hex'),onchainS_wad:signedS.toString(),finalized:result.finalized,retargets:result.retargets,checkpoints,firstCheckpoint:anchor.genesisHeight+4319,sourceA:'local Bitcoin P2P header archive',sourceB:'https://mempool.space/api/v1/blocks/:height',scope:'Every byte of current v3 anchor context through 100 descendants. Two acquisition paths, same-machine author verification; not independent operator or full block validation.'});
console.log('Complete two-source replay PASS. Next: node scripts/drill-v3-recovery.mjs '+out);
