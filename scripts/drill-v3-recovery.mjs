// Offline-only drill: public snapshot responses, independent headers, fresh caches, no signer or live RPC.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { HeaderHistory } from '../indexer/header-history.mjs';
import { digest, rawHash, displayHash } from './lib/header-verification.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.resolve(process.argv[2]||'');
assert.ok(process.argv[2]);const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name)));
const verified=read('verified.json'),snapshot=read('snapshot.json'); assert.equal(verified.status,'PASS');
const file=fs.readFileSync(path.join(dir,'http-span.bin'));assert.equal(digest(file).toString('hex'),verified.httpSha256);
const header=h=>{assert.ok(h>=verified.from&&h<=verified.to);return file.subarray((h-verified.from)*80,(h-verified.from+1)*80);};
const genesis=969546, tip=verified.to, end=verified.finalized.height;
const archiveDir=path.join(dir,'recovered-archive'),dataDir=path.join(dir,'recovered-indexer');
assert.ok(!fs.existsSync(archiveDir)&&!fs.existsSync(dataDir),'recovery must start empty');
const runtimeRoots=['runtime','runtime-rpc-2026-10-22-r2','operations-runtime-2026-10-22-r3'];
function fingerprints(){const result={};for(const name of runtimeRoots){
 const base=path.join(root,'operator/sepolia-header-v3',name);
 function walk(folder){for(const e of fs.readdirSync(folder,{withFileTypes:true})){const f=path.join(folder,e.name);if(e.isDirectory())walk(f);else if(/\.(mjs|html|json)$/.test(e.name))result[path.relative(root,f)]=digest(fs.readFileSync(f)).toString('hex');}}walk(base);
 }return result;}
const runtimeBefore=fingerprints();
const services=()=>spawnSync('/bin/launchctl',['list'],{encoding:'utf8'}).stdout.split('\n').filter(s=>/com\.wuji\.sepolia-header-v3-(keeper|indexer|operations)$/.test(s));
const servicesBefore=services();
const startedAt=new Date().toISOString(); const history=new HeaderHistory(archiveDir);
const byHash=new Map(Array.from({length:verified.headers},(_,i)=>{const b=header(verified.from+i);return [displayHash(b),b.toString('hex')];}));
const source={header:async h=>{assert.ok(byHash.has(h));return byHash.get(h);}};
for(let to=tip;to>=verified.from;){const from=Math.max(verified.from,to-1023);await history.headersFor(source,from,to,rawHash(header(to)).toString('hex'));to=from-1;}
// A new process reads the recovered content-addressed archive without any source/network fallback.
const childCheck=spawnSync(process.execPath,['--input-type=module','-e',`
 import fs from 'node:fs'; import assert from 'node:assert/strict';
 import { HeaderHistory } from ${JSON.stringify(new URL('../indexer/header-history.mjs',import.meta.url).href)};
 import { rawHash } from ${JSON.stringify(new URL('./lib/header-verification.mjs',import.meta.url).href)};
 const dir=process.argv[1],meta=JSON.parse(fs.readFileSync(dir+'/verified.json')),bytes=fs.readFileSync(dir+'/http-span.bin');
 const history=new HeaderHistory(dir+'/recovered-archive');
 for(let i=0;i<meta.headers;i++){const b=bytes.subarray(i*80,(i+1)*80);assert.equal(history.get(rawHash(b).toString('hex')),b.toString('hex'));}
 console.log(meta.headers);
`,dir],{encoding:'utf8',env:{PATH:process.env.PATH}});
assert.equal(childCheck.status,0,childCheck.stderr);
const tests=[];const test=async(name,fn)=>{await fn();tests.push(name);};
const faultHeight=Math.floor((genesis+end)/2),fault=header(faultHeight),hash=rawHash(fault).toString('hex'),faultFile=history.file(hash);
const offline={};
await test('missing header fails closed without network',async()=>{
 fs.unlinkSync(faultFile);await assert.rejects(history.headersFor(offline,faultHeight,faultHeight,hash),/unavailable/);
 await history.headersFor(source,faultHeight,faultHeight,hash);assert.equal(history.get(hash),fault.toString('hex'));
});
await test('corrupt bytes fail closed',async()=>{
 const bad=Buffer.from(fault);bad[76]^=1;fs.writeFileSync(faultFile,bad);
 assert.throws(()=>history.get(hash),/corrupt/);await assert.rejects(history.headersFor(source,faultHeight,faultHeight,hash),/corrupt/);
 fs.unlinkSync(faultFile);await history.headersFor(source,faultHeight,faultHeight,hash);
});
await test('wrong-branch source cannot substitute same height',async()=>{
 fs.unlinkSync(faultFile);
 await assert.rejects(history.headersFor({header:async()=>header(faultHeight+1).toString('hex'),at:async()=>({header:header(faultHeight+1).toString('hex')})},faultHeight,faultHeight,hash),/unavailable/);
 assert.equal(history.get(hash),null);await history.headersFor(source,faultHeight,faultHeight,hash);
});
let sourceRequests=0,rpcRequests=0,deniedWrites=0;const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const s=BigInt(verified.finalized.S_wad),calls={
 '0x4be1c796':word(s<0n?(1n<<256n)+s:s),'0x25159aa9':word(end),'0x207c8a4c':word(genesis),'0x3fa21806':verified.finalized.hash
};
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='POST'&&req.url==='/rpc'){
   let body='';for await(const b of req){body+=b;if(body.length>100000)throw Error('oversize');}
   const q=JSON.parse(body);rpcRequests++;let result;
   if(q.method==='eth_chainId')result='0xaa36a7';
   else if(q.method==='eth_getBlockByNumber'&&['latest',snapshot.block.number].includes(q.params[0]))result=snapshot.block;
   else if(q.method==='eth_call'&&q.params[0].to.toLowerCase()===snapshot.index.toLowerCase()&&q.params[1]===snapshot.block.number&&Object.hasOwn(calls,q.params[0].data))result=calls[q.params[0].data];
   else {deniedWrites++;res.writeHead(400);return res.end(JSON.stringify({error:'unapproved RPC method/target/snapshot'}));}
   res.setHeader('content-type','application/json');return res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
  }
  assert.equal(req.method,'GET');sourceRequests++;
  if(req.url==='/blocks/tip/height')return res.end(String(tip));
  let m=req.url.match(/^\/block-height\/(\d+)$/);if(m)return res.end(displayHash(header(Number(m[1]))));
  m=req.url.match(/^\/block\/([0-9a-f]{64})\/header$/);if(m&&byHash.has(m[1]))return res.end(byHash.get(m[1]));
  res.writeHead(404);res.end();
 }catch(e){res.writeHead(400);res.end(e.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
let child;
async function start(){
 // Force only the drill's HTTP listener to loopback; production modules are imported unchanged.
 const wrapper=`import http from 'node:http';const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(port,cb){return listen.call(this,port,'127.0.0.1',()=>{process.send({port:this.address().port});if(typeof cb==='function')cb();});};await import(${JSON.stringify(new URL('../indexer/index.mjs',import.meta.url).href)});`;
 child=spawn(process.execPath,['--input-type=module','-e',wrapper],{cwd:root,stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,SOURCE:'bitcoin',BITCOIN_SOURCE:'http',BITCOIN_API:url,BITCOIN_REQUEST_DELAY_MS:'0',GENESIS_HEIGHT:String(genesis),PORT:'0',DATA_DIR:dataDir,RPC:url+'/rpc',CONTRACT:snapshot.index,CHAIN_ID:'11155111'}});
 const output=fs.createWriteStream(path.join(dir,'isolated-indexer.log'),{flags:'a'});child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
 const port=await Promise.race([once(child,'message').then(([m])=>m.port),once(child,'exit').then(([code])=>{throw Error(`indexer exited ${code}`);}),new Promise((_,reject)=>setTimeout(()=>reject(Error('indexer startup timeout')),15000).unref())]);
 return `http://127.0.0.1:${port}`;
}
async function stop(){if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}child=null;}
async function ready(base){const deadline=Date.now()+180000;for(;;){
 const h=await(await fetch(base+'/head')).json();if(h.halted||h.err)throw Error(JSON.stringify(h));
 if(h.height===tip-6&&h.chain?.reconciliation==='matched')return h;
 if(Date.now()>deadline)throw Error(`isolated sync timed out ${h.height}`);await new Promise(r=>setTimeout(r,500));
}}
try{
 let base=await start();const first=await ready(base);
 const rows=await(await fetch(`${base}/blocks?from=${genesis}&to=${tip-6}`)).json();assert.equal(rows.length,tip-6-genesis+1);
 let u=0n;for(const row of rows){const b=header(row.height);u+=BigInt(digest(rawHash(b)).reduce((a,v)=>a+v,0)-4080);assert.equal(row.header,b.toString('hex'));assert.equal(String(row.U),u.toString());}
 const proof=await(await fetch(`${base}/proof/${end}`)).json();assert.equal(proof.S_wad,verified.finalized.S_wad);assert.equal(proof.internalHash,verified.finalized.hash.slice(2));
 const cache=path.join(dataDir,`bitcoin-${genesis}.json`),before=digest(fs.readFileSync(cache)).toString('hex');
 await stop();base=await start();const second=await ready(base);
 assert.equal(digest(fs.readFileSync(cache)).toString('hex'),before,'restart changed finalized cache');
 assert.equal(second.chain.S_wad,first.chain.S_wad);assert.equal(second.chain.lastHash,first.chain.lastHash);
 assert.equal(second.blocks,first.blocks);assert.equal(second.chain.observedHash,snapshot.block.hash);
 // Exercise the read-only boundary explicitly, without any forwarding or network access.
 const denied=await fetch(url+'/rpc',{method:'POST',body:JSON.stringify({id:1,method:'eth_sendRawTransaction',params:['0x']})});assert.equal(denied.status,400);
 const runtimeAfter=fingerprints();assert.deepEqual(runtimeAfter,runtimeBefore,'live runtime changed');
 const servicesAfter=services();assert.deepEqual(servicesAfter.filter(s=>!s.endsWith('-operations')),servicesBefore.filter(s=>!s.endsWith('-operations')),'live indexer/keeper PID/status changed');
 const liveBytes=fs.readFileSync(path.join(root,'operator/sepolia-header-v3/headers/mainnet.bin'));
 assert.equal(digest(liveBytes.subarray(verified.from*80,(verified.to+1)*80)).toString('hex'),verified.p2pSha256,'live archive prefix changed');
 const result={status:'PASS',startedAt,finishedAt:new Date().toISOString(),archiveHeaders:verified.headers,archiveNewProcessRead:true,faults:tests,indexerRows:rows.length,indexerDisplayHeight:second.height,contractHeight:end,contractConfirmations:100,indexerDisplayConfirmations:6,S_wad:proof.S_wad,allRowsVerified:true,cacheSha256:before,restartCacheIdentical:true,pinnedEvmBlockHash:snapshot.block.hash,sourceRequests,rpcRequests,deniedWrites,liveRuntimeFilesUnchanged:Object.keys(runtimeBefore).length,servicesBefore,servicesAfter,liveArchivePrefixUnchanged:true,liveRpcRequests:0,broadcasts:0,signerEnvironment:false,scope:'Same-machine offline restoration from independent HTTP headers and saved canonical EVM responses, production HeaderHistory and indexer; no keeper signing or 48-hour external takeover.'};
 fs.writeFileSync(path.join(dir,'recovery.json'),JSON.stringify(result,null,2)+'\n');fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({verification:verified,recovery:result},null,2)+'\n');console.log(JSON.stringify(result,null,2));
} finally {await stop();await new Promise(r=>server.close(r));}
