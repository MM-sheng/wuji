// Exercise the real keeper process with a public-header HTTP fixture and a non-signing cast test double.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import {step} from './bitcoin.mjs';
const realCast=process.env.CAST||path.join(os.homedir(),'.foundry/bin/cast');
const codec=(...args)=>execFileSync(realCast,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const signatures=['bestHeight()(uint64)','checkpointHeight()(uint64)','checkpointHash()(bytes32)','headerAt(uint64)(bytes32)','heightOf(bytes32)(uint64)','lastHeight()(uint64)','pending()(uint256)','fold(uint256)(uint64)','submitAndFold(bytes,uint256,address[])(uint64)'];
const selectors=new Map(signatures.map(sig=>[codec('sig',sig.slice(0,sig.indexOf(')')+1)),sig.split('(')[0]]));
const meta=JSON.parse(fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin.json',import.meta.url)));
const fixture=fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin-798336.hex',import.meta.url),'utf8').slice(2);
const castDouble=String.raw`#!/usr/bin/env node
import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const file=process.env.TEST_KEEPER_STATE,s=JSON.parse(fs.readFileSync(file)),a=process.argv.slice(2);
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const fail=m=>{save();process.stderr.write('Error: execution reverted: '+m);process.exit(1);};
const output=x=>process.stdout.write(String(x));
if(['calldata','abi-decode','to-unit'].includes(a[0])){output(execFileSync(process.env.TEST_CAST_CODEC,a,{encoding:'utf8'}));process.exit(0);}
if(a[0]==='wallet'){output(s.worker);process.exit(0);}
const name=a[2]?.split('(')[0],pending=()=>Math.max(0,s.best-6-s.folded);
if(a[0]==='send'){
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

for(const mode of ['catchup','fresh','wrong-chain','over-cap','zero-gas','chain-changed','low-balance','pending-tx','read-revert'])test(`keeper ${mode}: advance headers safely and simulate with the actual worker`,{timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-keeper-test-')),stateFile=path.join(dir,'state.json'),cast=path.join(dir,'cast.mjs');
 const cp=meta.checkpointHeight,headers={[cp]:meta.checkpointHeader},hashes={};
 for(let i=0;i<50;i++)headers[cp+1+i]=fixture.slice(i*160,(i+1)*160);
 for(const [h,raw] of Object.entries(headers))hashes[h]='0x'+step(raw).internalHash;
 const byHash=new Map(Object.values(headers).map(raw=>[step(raw).hash,raw]));
 const state={mode,checkpoint:cp,tip:cp+50,best:cp,folded:cp,headers,hashes,worker:'0x1111111111111111111111111111111111111111',sends:[],simulations:0,staleSimulations:0,estimates:0};
 fs.writeFileSync(stateFile,JSON.stringify(state));fs.writeFileSync(cast,castDouble,{mode:0o755});
 const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'){
   let raw='';for await(const part of req)raw+=part;
   const {method,params,id}=JSON.parse(raw),s=JSON.parse(fs.readFileSync(stateFile));
   const save=()=>fs.writeFileSync(stateFile,JSON.stringify(s)),hex=n=>'0x'+BigInt(n).toString(16),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
   const reply=result=>res.end(JSON.stringify({jsonrpc:'2.0',id,result}));
   const fail=message=>res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message}}));
   if(method==='eth_chainId')return reply(hex(s.mode==='wrong-chain'||(s.mode==='chain-changed'&&s.estimates>0)?1:97));
   if(method==='eth_getTransactionCount')return reply(hex(s.mode==='pending-tx'&&params[1]==='pending'?1:0));
   if(method==='eth_getBalance')return reply(hex(s.mode==='low-balance'?1:10n**18n));
   if(method==='eth_gasPrice')return reply(hex(10n**8n));
   if(method==='eth_estimateGas'){
    if(params[0].from!==s.worker)return fail('estimate must use actual worker');
    if(s.mode==='catchup'&&params[0].gasPrice!==hex(10n**8n))return fail('estimate must use selected fee');
    if(s.mode!=='catchup'&&params[0].gasPrice!==undefined)return fail('automatic fee selection changed');
    s.estimates++;save();return reply(hex(s.mode==='over-cap'?9000000:s.mode==='zero-gas'?0:300000));
   }
   if(method!=='eth_call')return fail('unexpected network method '+method);
   const tx=params[0],name=selectors.get(tx.data.slice(0,10)),stale=s.mode==='catchup'&&s.best<s.tip;
   if(s.mode==='read-revert')return fail('execution reverted: read denied');
   if(name==='bestHeight')return reply(word(s.best));
   if(name==='checkpointHeight')return reply(word(s.checkpoint));
   if(name==='checkpointHash')return reply(s.hashes[s.checkpoint]);
   if(name==='headerAt')return reply(s.hashes[Number(BigInt('0x'+tx.data.slice(10)))]);
   if(name==='lastHeight')return reply(word(s.folded));
   if(name==='pending')return reply(word(Math.max(0,s.best-6-s.folded)));
   if(name==='fold')return stale&&s.best-6>s.folded?fail('execution reverted: relay stale'):reply(word(0));
   if(name==='submitAndFold'){
    if(tx.from!==s.worker)return fail('zero/wrong simulated worker');
    const end=Math.min(s.tip,s.best+24),raw=Array.from({length:end-s.best},(_,i)=>s.headers[s.best+1+i]).join('');
    if(tx.data!==codec('calldata','submitAndFold(bytes,uint256,address[])','0x'+raw,'16','[]'))return fail('wrong simulated bytes');
    s.simulations++;
    if(s.mode==='catchup'&&end<s.tip){s.staleSimulations++;save();return fail('execution reverted: relay stale');}
    save();return reply(word(16));
   }
   return fail('unexpected call '+name);
  }

  if(req.url==='/blocks/tip/height')return res.end(String(state.tip));
  let match=req.url.match(/^\/block-height\/(\d+)$/);if(match&&headers[match[1]])return res.end(step(headers[match[1]]).hash);
  match=req.url.match(/^\/block\/([0-9a-f]+)\/header$/);if(match&&byHash.has(match[1]))return res.end(byHash.get(match[1]));
  res.statusCode=404;res.end();
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const url='http://127.0.0.1:'+server.address().port;let log='';
 const child=spawn(process.execPath,[new URL('./bitcoin-keeper.mjs',import.meta.url).pathname],{env:{...process.env,CHAIN_ID:'97',CAST:cast,TEST_CAST_CODEC:realCast,KEEPER_GAS_PRICE:mode==='catchup'?'0.1gwei':'',TEST_KEEPER_STATE:stateFile,BITCOIN_API:url,RPC:url,KEYSTORE_ACCOUNT:'test-double-only',PASSWORD_FILE:'/nonexistent/test-double-only',CONTRACT:'0x2222222222222222222222222222222222222222',RELAY:'0x3333333333333333333333333333333333333333',REWARDS:'0x4444444444444444444444444444444444444444',REWARD_MODEL:'operations-reserve',RELAY_TIMESTAMPS:'1',REWARD_TOKENS:'',FACTORY:'',VAULT:'',FEE_ROUTER:'',INTERVAL:'0.02'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 try{
  let result;
  const expectedFailure={'over-cap':/gas estimate exceeds operation ceiling/,'zero-gas':/invalid keeper gas estimate/,'chain-changed':/RPC chain mismatch/,'low-balance':/Insufficient native balance before signing/,'pending-tx':/pending transaction/,'read-revert':/read denied/}[mode];
  for(let i=0;i<600;i++){result=JSON.parse(fs.readFileSync(stateFile));if(result.folded===state.tip-6||(mode==='wrong-chain'&&log.includes('RPC chain mismatch'))||(expectedFailure&&expectedFailure.test(log)))break;if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,25));}
  if(mode==='wrong-chain'){assert.equal(result.sends.length,0);assert.match(log,/RPC chain mismatch/);return;}
  if(expectedFailure){assert.equal(result.sends.length,0);if(mode!=='read-revert')assert.ok(result.estimates>0);assert.match(log,expectedFailure);return;}
  assert.equal(result.folded,state.tip-6,log);
  assert.equal(result.estimates,result.sends.length,'each transaction must first estimate its actual execution');
  if(mode==='catchup'){
   assert.deepEqual(result.sends,['submit','submit','submit','fold','fold','fold']);
   assert.equal(result.staleSimulations,1);assert.match(log,/headers retained, fold deferred/);
  }else {assert.deepEqual(result.sends,['submitAndFold','submitAndFold','submitAndFold']);assert.equal(result.simulations,3);}
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
