// Exercise the real keeper process with a public-header HTTP fixture and a non-signing cast test double.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {step} from './bitcoin.mjs';
const meta=JSON.parse(fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin.json',import.meta.url)));
const fixture=fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin-798336.hex',import.meta.url),'utf8').slice(2);
const castDouble=String.raw`#!/usr/bin/env node
import fs from 'node:fs';
const file=process.env.TEST_KEEPER_STATE,s=JSON.parse(fs.readFileSync(file)),a=process.argv.slice(2);
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const fail=m=>{save();process.stderr.write('Error: execution reverted: '+m);process.exit(1);};
const output=x=>process.stdout.write(String(x));
if(a[0]==='chain-id'){output(s.mode==='wrong-chain'||(s.mode==='chain-changed'&&s.estimates>0)?1:97);process.exit(0);}
if(a[0]==='wallet'){output(s.worker);process.exit(0);}
const name=a[2].split('(')[0],stale=s.mode==='catchup'&&s.best<s.tip;
const pending=()=>Math.max(0,s.best-6-s.folded);
if(a[0]==='call'){
 if(name==='bestHeight')output(s.best);
 else if(name==='checkpointHeight')output(s.checkpoint);
 else if(name==='checkpointHash')output(s.hashes[s.checkpoint]);
 else if(name==='headerAt')output(s.hashes[Number(a[3])]);
 else if(name==='lastHeight')output(s.folded);
 else if(name==='pending')output(pending());
 else if(name==='fold'){if(stale&&pending())fail('relay stale');output(0);}
 else if(name==='submitAndFold'){
  if(a[a.indexOf('--from')+1]!==s.worker)fail('zero/wrong simulated worker');
  const end=s.best+(a[3].length-2)/160;s.simulations++;
  if(s.mode==='catchup'&&end<s.tip){s.staleSimulations++;fail('relay stale');}save();output(16);
 }else fail('unexpected read '+name);
}else if(a[0]==='estimate'){
 if(a[a.indexOf('--from')+1]!==s.worker)fail('gas estimate must use the actual worker');
 if(s.mode==='catchup'&&(!a.includes('--legacy')||a[a.indexOf('--gas-price')+1]!=='0.1gwei'))fail('estimate must use selected fee options');
 s.estimates++;save();output(s.mode==='over-cap'?9000000:s.mode==='zero-gas'?0:300000);
}else if(a[0]==='send'){
 if(a[a.indexOf('--gas-limit')+1]!=='375000')fail('reserve estimated gas plus headroom, not the fixed operation ceiling');
 if(s.mode==='catchup'){
  if(!a.includes('--legacy')||a[a.indexOf('--gas-price')+1]!=='0.1gwei')fail('missing explicit testnet gas price');
 }else if(a.includes('--legacy')||a.includes('--gas-price'))fail('automatic gas selection was overridden');
 if(name==='submit'||name==='submitAndFold'){
  const count=(a[3].length-2)/160;
  for(let i=0;i<count;i++)if(a[3].slice(2+i*160,2+(i+1)*160)!==s.headers[s.best+1+i])fail('wrong relayed bytes');
  if(name==='submitAndFold'&&s.mode==='catchup'&&s.best+count<s.tip)fail('atomic stale submission must not be sent');
  s.best+=count;
 }else if(name!=='fold')fail('unexpected send '+name);
 if(name==='fold'||name==='submitAndFold'){
  if(s.mode==='catchup'&&s.best<s.tip)fail('folding stale relay');
  s.folded+=Math.min(16,pending());
 }
 s.sends.push(name);save();output(JSON.stringify({status:'0x1',transactionHash:'0x'+s.sends.length.toString(16).padStart(64,'0')}));
}else fail('unexpected command');
`;

for(const mode of ['catchup','fresh','wrong-chain','over-cap','zero-gas','chain-changed'])test(`keeper ${mode}: advance headers safely and simulate with the actual worker`,{timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-keeper-test-')),stateFile=path.join(dir,'state.json'),cast=path.join(dir,'cast.mjs');
 const cp=meta.checkpointHeight,headers={[cp]:meta.checkpointHeader},hashes={};
 for(let i=0;i<50;i++)headers[cp+1+i]=fixture.slice(i*160,(i+1)*160);
 for(const [h,raw] of Object.entries(headers))hashes[h]='0x'+step(raw).internalHash;
 const byHash=new Map(Object.values(headers).map(raw=>[step(raw).hash,raw]));
 const state={mode,checkpoint:cp,tip:cp+50,best:cp,folded:cp,headers,hashes,worker:'0x1111111111111111111111111111111111111111',sends:[],simulations:0,staleSimulations:0,estimates:0};
 fs.writeFileSync(stateFile,JSON.stringify(state));fs.writeFileSync(cast,castDouble,{mode:0o755});
 const server=http.createServer((req,res)=>{
  if(req.url==='/blocks/tip/height')return res.end(String(state.tip));
  let match=req.url.match(/^\/block-height\/(\d+)$/);if(match&&headers[match[1]])return res.end(step(headers[match[1]]).hash);
  match=req.url.match(/^\/block\/([0-9a-f]+)\/header$/);if(match&&byHash.has(match[1]))return res.end(byHash.get(match[1]));
  res.statusCode=404;res.end();
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const url='http://127.0.0.1:'+server.address().port;let log='';
 const child=spawn(process.execPath,[new URL('./bitcoin-keeper.mjs',import.meta.url).pathname],{env:{...process.env,CHAIN_ID:'97',CAST:cast,KEEPER_GAS_PRICE:mode==='catchup'?'0.1gwei':'',TEST_KEEPER_STATE:stateFile,BITCOIN_API:url,RPC:url,KEYSTORE_ACCOUNT:'test-double-only',PASSWORD_FILE:'/nonexistent/test-double-only',CONTRACT:'0x2222222222222222222222222222222222222222',RELAY:'0x3333333333333333333333333333333333333333',REWARDS:'0x4444444444444444444444444444444444444444',REWARD_MODEL:'operations-reserve',RELAY_TIMESTAMPS:'1',REWARD_TOKENS:'',FACTORY:'',VAULT:'',FEE_ROUTER:'',INTERVAL:'0.02'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 try{
  let result;
  const expectedFailure={'over-cap':/gas estimate exceeds operation ceiling/,'zero-gas':/invalid keeper gas estimate/,'chain-changed':/RPC chain mismatch/}[mode];
  for(let i=0;i<600;i++){result=JSON.parse(fs.readFileSync(stateFile));if(result.folded===state.tip-6||(mode==='wrong-chain'&&log.includes('RPC chain mismatch'))||(expectedFailure&&expectedFailure.test(log)))break;if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,25));}
  if(mode==='wrong-chain'){assert.equal(result.sends.length,0);assert.match(log,/RPC chain mismatch/);return;}
  if(expectedFailure){assert.equal(result.sends.length,0);assert.ok(result.estimates>0);assert.match(log,expectedFailure);return;}
  assert.equal(result.folded,state.tip-6,log);
  assert.equal(result.estimates,result.sends.length,'each transaction must first estimate its actual execution');
  if(mode==='catchup'){
   assert.deepEqual(result.sends,['submit','submit','submit','fold','fold','fold']);
   assert.equal(result.staleSimulations,1);assert.match(log,/headers retained, fold deferred/);
  }else {assert.deepEqual(result.sends,['submitAndFold','submitAndFold','submitAndFold']);assert.equal(result.simulations,3);}
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
