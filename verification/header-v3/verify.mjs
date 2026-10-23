// Read-only public-data verification. Node standard library only; no environment-file or signer access.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hashHex, calls, checkRpcEvidence, encodeMetadata, replay, serializeSeries } from './reference.mjs';

export const PACKAGE = path.dirname(fileURLToPath(import.meta.url));
export const candidate = JSON.parse(fs.readFileSync(path.join(PACKAGE,'candidate.json'),'utf8'));
const candidateHash = hashHex(fs.readFileSync(path.join(PACKAGE,'candidate.json')));
const json = file => {
  const text=fs.readFileSync(file,'utf8');
  try {return JSON.parse(text);}
  catch {throw Error(`invalid JSON evidence: ${path.basename(file)}; preserve this directory, resolve any storage issue, then fetch into a new directory`);}
};
const pretty = v => JSON.stringify(v,null,2)+'\n';
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
function put(file,data) {
  const bytes=Buffer.isBuffer(data)?data:Buffer.from(typeof data==='string'?data:pretty(data));
  if (fs.existsSync(file)) assert.ok(fs.readFileSync(file).equals(bytes),`existing file differs: ${path.basename(file)}`);
  else fs.writeFileSync(file,bytes,{flag:'wx'});
}
export function endpoint(value) {
  const url=new URL(value);
  assert.ok(url.protocol==='https:' || (url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)),'use HTTPS or loopback HTTP');
  assert.ok(!url.username&&!url.password&&!url.search&&!url.hash,'use a public endpoint without credentials, query, or fragment');
  return url.href.replace(/\/$/,'');
}
async function request(url,options={},fetcher=fetch) {
  let last;
  for (let attempt=0;attempt<3;attempt++) {
    try {
      const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(25000)});
      if (!response.ok) {
        const retryAfter=response.headers?.get('retry-after');
        await response.body?.cancel().catch(()=>{});
        const error=Error(`HTTP ${response.status}`);
        // Stop rather than sleeping for an unbounded provider cooldown or retrying too early.
        if(response.status===429 || retryAfter!==undefined&&retryAfter!==null) {
          const value=String(retryAfter??'').trim(),seconds=/^\d+$/.test(value)?Number(value):NaN;
          const date=value&&!/^\d+$/.test(value)?Date.parse(value):NaN;
          const hint=Number.isSafeInteger(seconds)?`wait at least ${seconds} seconds before manually resuming`
            :Number.isFinite(date)?`do not manually resume before ${new Date(date).toUTCString()}`
            :'consult the provider cooldown before manually resuming';
          error.message+=`; request stopped without automatic retry; ${hint}`;
          error.stopRetry=true;
        }
        throw error;
      }
      const text=await response.text();assert.ok(text.length<=2_000_000,'response too large');return JSON.parse(text);
    } catch (error) {if(error.stopRetry)throw error;last=error;if(attempt<2)await pause(1000*2**attempt);}
  }
  throw Error(`public-data request failed: ${last.message}`);
}
export function makeRpc(value,c=candidate,fetcher=fetch) {
  const url=endpoint(value),allowedCalls=new Set(Object.values(calls(c)));let id=0;
  return async (method,params) => {
    assert.ok(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call'].includes(method),'read-only RPC method required');
    if(method==='eth_chainId')assert.deepEqual(params,[]);
    if(method==='eth_getBlockByNumber')assert.ok(params.length===2&&params[1]===false&&[c.block.number,'finalized'].includes(params[0]),'fixed or finalized block only');
    if(method==='eth_getCode')assert.deepEqual(params,[c.index,c.block.number]);
    if(method==='eth_call') {
      assert.equal(params.length,2);assert.equal(params[1],c.block.number);
      assert.deepEqual(Object.keys(params[0]).sort(),['data','to']);assert.equal(params[0].to,c.index);
      assert.ok(allowedCalls.has(params[0].data),'allowlisted view only');
    }
    const requestId=++id;
    const answer=await request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})},fetcher);
    assert.equal(answer.id,requestId,'RPC response ID');assert.equal(answer.jsonrpc,'2.0');
    assert.ok(!answer.error,`RPC ${method} error code ${answer.error?.code ?? 'unknown'}`);
    assert.ok(answer.result!==undefined&&answer.result!==null,`RPC ${method} missing result`);return answer.result;
  };
}
export async function readRpc(value,c=candidate,fetcher=fetch) {
  const rpc=makeRpc(value,c,fetcher);
  const chainId=await rpc('eth_chainId',[]);
  assert.equal(BigInt(chainId),BigInt(c.chainId),'chain ID');
  const blockBefore=await rpc('eth_getBlockByNumber',[c.block.number,false]);
  assert.equal(blockBefore.hash,c.block.hash,'pinned EVM block hash');
  const finalized=await rpc('eth_getBlockByNumber',['finalized',false]);
  const entries=Object.entries(calls(c));
  const [code,...values]=await Promise.all([
    rpc('eth_getCode',[c.index,c.block.number]),
    ...entries.map(([,data])=>rpc('eth_call',[{to:c.index,data},c.block.number])),
  ]);
  const blockAfter=await rpc('eth_getBlockByNumber',[c.block.number,false]);
  const brief=b=>({number:b.number,hash:b.hash,timestamp:b.timestamp});
  const evidence={observedAt:new Date().toISOString(),rpc:endpoint(value),chainId,
    blockBefore:brief(blockBefore),blockAfter:brief(blockAfter),finalized:brief(finalized),code,
    reads:Object.fromEntries(entries.map(([sig],i)=>[sig,values[i]]))};
  checkRpcEvidence(evidence,c);return evidence;
}
function decodePage(list,cursor) {
  assert.ok(Array.isArray(list)&&list.length>0&&list.length<=15,'expected 1..15 block metadata records');
  for(let i=0;i<list.length;i++){assert.equal(list[i].height,cursor-i,'page height sequence');encodeMetadata(list[i]);}
  return list;
}
function checkRpcMetadata(evidence,rpcUrl) {
  assert.equal(endpoint(evidence.rpc),rpcUrl,'RPC source differs from source.json');
  const observed=Date.parse(evidence.observedAt);
  assert.ok(typeof evidence.observedAt==='string'&&Number.isFinite(observed)
    &&new Date(observed).toISOString()===evidence.observedAt,'invalid RPC observation timestamp');
}
function collect(out,index,c,bitcoinApi) {
  let cursor=c.expected.seenHeight;const headers=new Map();
  for(const entry of index) {
    assert.equal(entry.height,cursor,'page coverage');
    assert.equal(entry.file,`${cursor}.json`,'page filename');
    assert.equal(entry.url,`${bitcoinApi}/v1/blocks/${cursor}`,'page source differs from source.json');
    const bytes=fs.readFileSync(path.join(out,'pages',entry.file));
    assert.equal(hashHex(bytes),entry.sha256,'page checksum');
    const list=decodePage(JSON.parse(bytes),cursor);
    for(const b of list)if(b.height>=c.anchor.epochFirst)headers.set(b.height,encodeMetadata(b));
    cursor=list.at(-1).height-1;
  }
  assert.ok(cursor<c.anchor.epochFirst,'incomplete pages');
  assert.equal(headers.size,c.expected.seenHeight-c.anchor.epochFirst+1,'header range');
  return Buffer.concat(Array.from({length:headers.size},(_,i)=>headers.get(c.anchor.epochFirst+i)));
}
export function verifyArchive(directory,c=candidate) {
  const out=path.resolve(directory),config=json(path.join(out,'source.json'));
  assert.equal(config.candidateSha256,candidateHash,'candidate identity');
  assert.equal(config.candidateId,c.id,'candidate ID');
  const sources={rpc:endpoint(config.rpc),bitcoinApi:endpoint(config.bitcoinApi)};
  const evidence=json(path.join(out,'rpc.json'));checkRpcEvidence(evidence,c);
  checkRpcMetadata(evidence,sources.rpc);
  const finalBlock=json(path.join(out,'final-block.json'));
  assert.deepEqual(finalBlock,c.block,'final EVM block recheck');
  const bytes=collect(out,json(path.join(out,'pages.json')),c,sources.bitcoinApi);
  assert.ok(bytes.equals(fs.readFileSync(path.join(out,'headers.bin'))),'header archive differs from metadata');
  const result=replay(bytes,c),series=serializeSeries(result.series);
  assert.equal(fs.readFileSync(path.join(out,'series.ndjson'),'utf8'),series,'consumer series differs');
  return {status:'PASS_OFFLINE_REPLAY',candidate:c.id,candidateSha256:candidateHash,
    chainId:c.chainId,index:c.index,evmBlock:c.block,bitcoin:{from:result.from,to:result.to,
      headers:result.headers,finalized:result.finalized,confirmations:c.confirmations,retargets:result.retargets},
    headersSha256:hashHex(bytes),seriesSha256:hashHex(Buffer.from(series)),rows:result.series.length,
    checkpoint:{height:result.firstCheckpoint,status:result.checkpointStatus},
    observation:evidence.observedAt,
    sources:{...sources,labelConsistency:'CHECKED',authenticity:'NOT_ATTESTED'},
    evidenceSha256:Object.fromEntries(['source.json','rpc.json','pages.json','final-block.json']
      .map(file=>[file,hashHex(fs.readFileSync(path.join(out,file)))])),
    operatorIndependence:'NOT_ATTESTED',
    scope:'Historical fixed-block replay; not live freshness, full Bitcoin validation, solvency, or an audit.'};
}
export async function download(directory,options={}) {
  const out=path.resolve(directory),rpcUrl=endpoint(options.rpc||candidate.defaults.rpc),api=endpoint(options.bitcoinApi||candidate.defaults.bitcoinApi);
  assert.ok(out!==PACKAGE&&!out.startsWith(PACKAGE+path.sep)&&!PACKAGE.startsWith(out+path.sep),'use a separate output directory');
  const config={candidateId:candidate.id,candidateSha256:candidateHash,rpc:rpcUrl,bitcoinApi:api};
  if(fs.existsSync(out)) {
    assert.ok(fs.lstatSync(out).isDirectory()&&!fs.lstatSync(out).isSymbolicLink(),'output must be a directory');
    assert.deepEqual(json(path.join(out,'source.json')),config,'resume configuration differs');
    assert.ok(!fs.existsSync(path.join(out,'result.json')),'completed archive: use replay or a new directory');
  } else {fs.mkdirSync(out);put(path.join(out,'source.json'),config);}
  fs.mkdirSync(path.join(out,'pages'),{recursive:true});
  if(fs.existsSync(path.join(out,'rpc.json'))) {
    const cached=json(path.join(out,'rpc.json'));checkRpcEvidence(cached,candidate);checkRpcMetadata(cached,rpcUrl);
  }
  const fresh=await readRpc(rpcUrl);
  if(!fs.existsSync(path.join(out,'rpc.json')))put(path.join(out,'rpc.json'),fresh);
  const pages=[];
  for(let cursor=candidate.expected.seenHeight;cursor>=candidate.anchor.epochFirst;) {
    const file=`${cursor}.json`,dest=path.join(out,'pages',file),url=`${api}/v1/blocks/${cursor}`;
    let list;
    if(fs.existsSync(dest))list=decodePage(json(dest),cursor);
    else {list=decodePage(await request(url),cursor);put(dest,list);await pause(1000);}
    pages.push({height:cursor,file,url,sha256:hashHex(fs.readFileSync(dest))});
    cursor=list.at(-1).height-1;
    if(pages.length%25===0)console.error(`Downloaded through Bitcoin height ${cursor+1}; ${pages.length} pages verified.`);
  }
  put(path.join(out,'pages.json'),pages);
  const bytes=collect(out,pages,candidate,api),result=replay(bytes,candidate);
  put(path.join(out,'headers.bin'),bytes);put(path.join(out,'series.ndjson'),serializeSeries(result.series));
  const block=await makeRpc(rpcUrl)('eth_getBlockByNumber',[candidate.block.number,false]);
  const last={number:block.number,hash:block.hash,timestamp:block.timestamp};assert.deepEqual(last,candidate.block,'final EVM block recheck');
  put(path.join(out,'final-block.json'),last);
  const verified={...verifyArchive(out),status:'PASS_PUBLIC_REPLAY'};
  put(path.join(out,'result.json'),verified);return verified;
}
export function integrity() {
  const lines=fs.readFileSync(path.join(PACKAGE,'SHA256SUMS'),'utf8').trim().split('\n');
  for(const line of lines) {
    const match=/^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);assert.ok(match,'checksum manifest syntax');
    assert.equal(hashHex(fs.readFileSync(path.join(PACKAGE,match[2]))),match[1],`package checksum: ${match[2]}`);
  }
  return {status:'PASS_PACKAGE_CHECKSUMS',files:lines.length,scope:'Integrity relative to this manifest, not publisher authentication.'};
}
async function main(argv) {
  const [mode,directory,...flags]=argv;
  if(mode==='integrity'){assert.equal(argv.length,1);return integrity();}
  assert.ok(['fetch','replay','check-rpc'].includes(mode)&&directory,
    'Usage: node verify.mjs fetch DIR [--rpc URL] [--bitcoin-api URL] | replay DIR | check-rpc DIR --rpc URL | integrity');
  const options={};
  for(let i=0;i<flags.length;i+=2) {
    assert.ok(['--rpc','--bitcoin-api'].includes(flags[i])&&flags[i+1],'unknown or incomplete option');
    const key=flags[i]==='--rpc'?'rpc':'bitcoinApi';assert.ok(!options[key],'duplicate option');options[key]=flags[i+1];
  }
  if(mode==='fetch')return download(directory,options);
  assert.ok(!options.bitcoinApi,'bitcoin API applies only to fetch');
  const verified=verifyArchive(directory);
  if(mode==='replay'){assert.ok(!options.rpc,'offline replay does not use RPC');return verified;}
  assert.ok(options.rpc,'check-rpc requires an explicit public RPC');await readRpc(options.rpc);
  return {...verified,status:'PASS_RPC_RECHECK',checkedRpc:endpoint(options.rpc),checkedAt:new Date().toISOString()};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result=>console.log(pretty(result))).catch(error=>{
    console.error(`FAIL: ${error.message}`);process.exitCode=1;
  });
}
