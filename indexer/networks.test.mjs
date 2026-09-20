import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';import {step} from './bitcoin.mjs';
test('Sepolia indexer refuses the wrong RPC and pins vault metadata to its index observation',{timeout:20000},async()=>{
 const genesis=798336,fixture=fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin-798336.hex',import.meta.url),'utf8').slice(2);
 const blocks=Array.from({length:20},(_,i)=>{const header=fixture.slice(i*160,(i+1)*160);return {header,...step(header)};});
 const address=n=>'0x'+String(n).repeat(40),word=n=>BigInt(n).toString(16).padStart(64,'0'),contract=address(1),factory=address(2),vault=address(3),asset=address(4);
 let chainId=97;const calls=[];
 const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'){
   let body='';for await(const b of req)body+=b;const {id,method,params}=JSON.parse(body);let result;
   if(method==='eth_chainId')result='0x'+chainId.toString(16);
   if(method==='eth_blockNumber')result='0x55';
   if(method==='eth_call'){
    calls.push(params);const {to,data}=params[0],sig=data.slice(0,10);let value;
    if(to===contract)value={'0x4be1c796':word(0),'0x25159aa9':word(genesis-1),'0x207c8a4c':word(genesis),'0x3fa21806':word(0)}[sig];
    else if(to===factory)value={'0x06661abd':word(1),'0x8c64ea4a':word(BigInt(vault))}[sig];
    else if(to===vault)value={'0xdbc1faef':word(500000000000000000n),'0xe00dd161':word(0),'0x38d52e0f':word(BigInt(asset)),'0xb4add307':word(0),'0xdc22cb6a':[BigInt(address(5)),BigInt(address(6)),0,genesis,genesis+4319,0,0].map(word).join(''),'0xbf911794':word(32)+word(4)+Buffer.from('WETH').toString('hex').padEnd(64,'0'),'0x858dccb3':word(1000000000000000n)}[sig];
    else if(to===asset&&sig==='0x70a08231')value=word(0);
    if(value===undefined){res.end(JSON.stringify({id,jsonrpc:'2.0',error:{message:'unexpected call '+data}}));return;}result='0x'+value;
   }
   res.setHeader('content-type','application/json');res.end(JSON.stringify({id,jsonrpc:'2.0',result}));return;
  }
  if(req.url==='/blocks/tip/height'){res.end(String(genesis+10));return;}
  if(req.url.startsWith('/block-height/')){res.end(blocks[Number(req.url.split('/').at(-1))-genesis].hash);return;}
  const block=blocks.find(b=>b.hash===req.url.split('/')[2]);res.end(block?.header||'');
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-networks-')),url='http://127.0.0.1:'+server.address().port;
 const child=spawn(process.execPath,[new URL('./bitcoin-index.mjs',import.meta.url).pathname],{env:{...process.env,GENESIS_HEIGHT:String(genesis),DATA_DIR:dir,PORT:String(port),RPC:url,BITCOIN_API:url,CHAIN_ID:'11155111',CONTRACT:contract,FACTORY:factory,RELAY_TIMESTAMPS:'0'},stdio:'ignore'});
 const until=async fn=>{for(let i=0;i<100;i++){try{const h=await(await fetch('http://127.0.0.1:'+port+'/head')).json();if(fn(h))return h;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('indexer timeout');};
 try{
  const wrong=await until(h=>h.chain?.err);assert.match(wrong.chain.err,/RPC chain mismatch/);assert.equal(calls.length,0);
  chainId=11155111;const h=await until(h=>h.chain?.vault);assert.equal(h.chain.vault.chainId,11155111);assert.equal(h.chain.vault.networkName,'Ethereum Sepolia');assert.equal(h.chain.vault.explorer,'https://sepolia.etherscan.io');assert.equal(h.chain.vault.symbol,'WETH');assert.equal(h.chain.vault.notional,0.001);assert.ok(calls.length>10);for(const p of calls)assert.equal(p[1],'0x55');
 }finally{child.kill();await once(child,'exit');server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
