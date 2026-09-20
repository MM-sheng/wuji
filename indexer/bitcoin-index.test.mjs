import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {step} from './bitcoin.mjs';
const headers=Buffer.from(fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin-798336.hex',import.meta.url),'utf8').slice(2),'hex');
test('Bitcoin HTTP source finalizes six-deep headers, serves exact proofs, persists and halts on deep reorg',async()=>{
 const start=798336,blocks=new Map();for(let i=0;i<20;i++){const h=headers.subarray(i*80,(i+1)*80);blocks.set(start+i,{header:h.toString('hex'),...step(h)});}
 let reorg=false;
 const source=http.createServer((req,res)=>{
  if(req.url==='/blocks/tip/height')return res.end(String(start+10));
  if(req.url.startsWith('/block-height/')){const h=Number(req.url.split('/').at(-1));return res.end(reorg&&h===start+4?'aa'.repeat(32):blocks.get(h).hash);}
  const hash=req.url.split('/')[2],r=[...blocks.values()].find(b=>b.hash===hash);if(!r){res.statusCode=404;return res.end();}res.end(r.header);
 });await new Promise(r=>source.listen(0,'127.0.0.1',r));
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-bitcoin-test-'));
 const env={...process.env,SOURCE:'bitcoin',GENESIS_HEIGHT:String(start),PORT:String(port),DATA_DIR:dir,BITCOIN_API:`http://127.0.0.1:${source.address().port}`,CONTRACT:'',FACTORY:''};
 let child;const run=()=>{child=spawn(process.execPath,[new URL('./index.mjs',import.meta.url).pathname],{env,stdio:'ignore'});};
 const get=route=>fetch(`http://127.0.0.1:${port}${route}`);
 async function until(predicate){for(let i=0;i<200;i++){try{const h=await(await get('/head')).json();if(predicate(h))return h;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('timeout');}
 try{
  run();const h=await until(h=>h.blocks===5);assert.equal(h.height,start+4);
  const proof=await(await get('/proof/'+(start+4))).json();let U=0;for(let i=0;i<5;i++)U+=blocks.get(start+i).delta;
  assert.equal(proof.U,U);assert.equal(proof.S_wad,(BigInt(U)*12000000000000n).toString());
  const sec=Buffer.from(await(await get(`/seconds?from=${proof.ts}&to=${proof.ts+2}`)).arrayBuffer());assert.equal(sec.readFloatLE(0),Math.fround(proof.price));assert.equal(sec.readFloatLE(8),Math.fround(proof.price));
  child.kill();await new Promise(r=>child.once('exit',r));run();assert.equal((await until(h=>h.blocks===5)).U,U);
  reorg=true;const halted=await until(h=>h.halted);assert.match(halted.err,/deep Bitcoin reorg/);assert.equal(halted.blocks,5);
 }finally{if(child&&child.exitCode===null)child.kill();source.close();fs.rmSync(dir,{recursive:true,force:true});}
});
