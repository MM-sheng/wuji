import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {step} from './bitcoin.mjs';
const dir=new URL('../contracts/test/fixtures/',import.meta.url);
const meta=JSON.parse(fs.readFileSync(new URL('bitcoin.json',dir)));
const headers=Buffer.from(fs.readFileSync(new URL('bitcoin-798336.hex',dir),'utf8').slice(2),'hex');
const vectors=fs.readFileSync(new URL('bitcoin-vectors.hex',dir),'utf8').slice(2);
test('all 2028 headers match committed Solidity vectors and total',()=>{
 let U=0,previous=step(meta.checkpointHeader).hash;
 for(let i=0;i<meta.count;i++){
  const h=headers.subarray(i*80,(i+1)*80),s=step(h);assert.equal(Buffer.from(h.subarray(4,36)).reverse().toString('hex'),previous);
  assert.equal(s.R,vectors.slice(i*64,(i+1)*64));U+=s.delta;previous=s.hash;
 }
 assert.equal(U,meta.U);assert.equal((BigInt(U)*12000000000000n).toString(),meta.S_wad);
});
test('height 800000 fixes digest order and known explorer identity',()=>{
 const at=(800000-meta.start)*80,s=step(headers.subarray(at,at+80));assert.deepEqual(s,meta.known800000);
 assert.equal(s.hash,'00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054');
 assert.equal(s.R,'74323d1b46bfc56d162ea5725ebc666028c5ee2b0a4824e32dedff53fe3ec1fd');
});
test('local Core REST adapter uses the documented endpoints',async()=>{
 const {default:http}=await import('node:http');const {BitcoinAPI}=await import('./bitcoin.mjs');
 const h=headers.subarray(0,80),hash=step(h).hash,seen=[];
 const server=http.createServer((req,res)=>{seen.push(req.url);if(req.url==='/rest/chaininfo.json')return res.end(JSON.stringify({blocks:798336}));if(req.url==='/rest/blockhashbyheight/798336.json')return res.end(JSON.stringify({blockhash:hash}));if(req.url===`/rest/headers/${hash}.hex?count=1`)return res.end(h.toString('hex'));res.statusCode=404;res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const previous=process.env.BITCOIN_API_KIND;process.env.BITCOIN_API_KIND='bitcoind-rest';
 try{const api=new BitcoinAPI([`http://127.0.0.1:${server.address().port}`]);assert.equal(await api.tip(),798336);assert.equal(await api.hashAt(798336),hash);assert.equal((await api.at(798336)).header,h.toString('hex'));assert.equal(seen.at(-1),`/rest/headers/${hash}.hex?count=1`);}
 finally{if(previous===undefined)delete process.env.BITCOIN_API_KIND;else process.env.BITCOIN_API_KIND=previous;server.close();}
});
