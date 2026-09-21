// Real local EVM transactions through the production browser exit function and keeper policy.
// The relay feeder is explicitly test-only. This is NOT a real Bitcoin PoW reorg or a public-chain drill.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import vm from 'node:vm';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
import {rpcRequest} from '../indexer/evm-rpc.mjs';import {maintainFrozenExit} from '../indexer/frozen-keeper.mjs';
const root=path.resolve(new URL('..',import.meta.url).pathname),bin=n=>process.env[n.toUpperCase()]||path.join(os.homedir(),'.foundry/bin',n);
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const url='http://127.0.0.1:'+port;
const anvil=spawn(bin('anvil'),['--host','127.0.0.1','--port',String(port),'--chain-id','11155111','--silent'],{stdio:'ignore'});
const rpc=(m,p)=>rpcRequest(url,m,p,{attempts:1,timeoutMs:2000});
const cast=(...a)=>execFileSync(bin('cast'),a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const data=(sig,...a)=>cast('calldata',sig,...a.map(String));
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
let accounts,transactions=0;
try{
 for(let i=0;i<100;i++){try{accounts=await rpc('eth_accounts',[]);break;}catch{await new Promise(r=>setTimeout(r,50));}}
 assert.ok(accounts?.length,'local node unavailable');
 execFileSync(bin('forge'),['build','--root',path.join(root,'contracts')],{stdio:['ignore','pipe','pipe']});
 const tx=async(to,encoded,from=accounts[0])=>{
  const hash=await rpc('eth_sendTransaction',[{from,...(to?{to}:{}),data:encoded,gas:'0x989680'}]);
  let receipt;for(let i=0;i<100;i++){receipt=await rpc('eth_getTransactionReceipt',[hash]);if(receipt)break;await new Promise(r=>setTimeout(r,20));}assert.equal(receipt?.status,'0x1');transactions++;return receipt;
 };
 const deploy=async(name,file,sig,...args)=>{
  const artifact=JSON.parse(fs.readFileSync(path.join(root,'contracts/out',file+'.sol',name+'.json')));
  return (await tx(null,artifact.bytecode.object+(sig?cast('abi-encode',sig,...args.map(String)).slice(2):''))).contractAddress;
 };
 const relay=await deploy('FrozenExitRelayMock','FrozenExitRelayMock');
 const index=await deploy('WujiIndex','WujiIndex','f(address,uint64,uint64,address)',relay,1000,20,'0x'+'0'.repeat(40));
 const asset=await deploy('MockUSDT','MockUSDT'),tokens=await deploy('SeriesTokenDeployer','SeriesToken');
 const vault=await deploy('WujiVault','WujiVault','f(address,address,uint256,address,address)',asset,index,10n**18n,accounts[2],tokens);
 await tx(asset,data('mint(address,uint256)',accounts[0],100n*10n**18n));
 await tx(asset,data('approve(address,uint256)',vault,100n*10n**18n));
 await tx(vault,data('mint(uint256)',2n*10n**18n));
 const series=await rpc('eth_call',[{to:vault,data:data('series(uint256)',0)},'latest']);
 const yin='0x'+series.slice(2+64+24,2+128);
 await tx(yin,data('transfer(address,uint256)',accounts[1],10n**18n));
 // One confirmed height, then a replacement of exactly that folded hash.
 await tx(relay,data('put(uint64,bytes32)',1000,word(11)));
 await tx(relay,data('tip(uint64,bytes32,bool)',1006,word(12),false));
 await tx(index,data('fold(uint256)',1));
 await tx(relay,data('put(uint64,bytes32)',1000,word(13)));
 await tx(relay,data('tip(uint64,bytes32,bool)',1007,word(14),true));
 const operations=[];
 const maintain=()=>maintainFrozenExit({rpc,index,relay,vaults:()=>[vault],chainId:11155111,send:async(to,sig)=>{operations.push(sig);await tx(to,data(sig));}});
 assert.equal((await maintain()).phase,'unobserved');
 let state=await maintain();assert.equal(state.phase,'waiting');assert.equal(state.remaining,144);assert.equal(operations.length,1);
 // A winning branch revision invalidates the old observation; keeper starts a fresh window.
 await tx(relay,data('tip(uint64,bytes32,bool)',1008,word(15),true));
 assert.equal((await maintain()).phase,'unobserved');state=await maintain();assert.equal(state.readyHeight,1152);
 await assert.rejects(rpc('eth_call',[{to:index,data:data('freeze()')},'latest']),/not ready/);
 await tx(relay,data('tip(uint64,bytes32,bool)',1152,word(16),false));
 assert.equal((await maintain()).phase,'ready');assert.equal((await maintain()).phase,'frozen');
 assert.deepEqual(operations,['observeReorg()','observeReorg()','freeze()','settleFrozen()']);
 await assert.rejects(rpc('eth_call',[{from:accounts[0],to:vault,data:data('mint(uint256)',1)},'latest']),/closed/);
 // Execute the exact standalone terminal code. No indexer exists and every signing request is local/unlocked.
 const html=fs.readFileSync(path.join(root,'apps/terminal/index.html'),'utf8');
 const helpers=html.slice(html.indexOf('  const ADDRESS='),html.indexOf('  // END VERIFICATION HELPERS'));
 const wallet=html.slice(html.indexOf('  const W={acct:'),html.indexOf("  $('wConnect').onclick=connect;"));
 const d={index,relay,chainId:11155111,frozenExit:true,frozenExitDelay:144},v={address:vault,asset,notional:String(10n**18n)};
 let walletChain=11155111,reportedAccount;
 const provider={request:async({method,params=[]})=>{
  if(method==='eth_chainId')return '0x'+walletChain.toString(16);
  if(method==='eth_accounts')return [reportedAccount||ctx.api.W.acct];
  if(method==='eth_sendTransaction'){
   assert.equal(params[0].chainId,'0xaa36a7');transactions++;
   return rpc(method,[{...params[0],gas:'0x989680'}]);
  }
  return rpc(method,params);
 }};
 const ctx=vm.createContext({URL,Date,window:{ethereum:provider},setTimeout,HEAD:{err:'indexer completely offline'},headReceived:0,
  deployment:()=>d,selectedVerificationVault:()=>v,activeRPC:()=>url,checkResult:null,checkRPC:()=>{},curVault:()=>null,short:x=>x,fetchTimed:fetch});
 vm.runInContext(helpers+'\n'+wallet+'\nrenderWallet=()=>{};renderExit=()=>{};this.api={W,doExit,exitForm,verifySnapshot,exactAmount};',ctx);
 let snap=await ctx.api.verifySnapshot(rpc,d,v,{},0);
 assert.equal(snap.status,'direct-only');assert.equal(snap.closed,true);assert.equal(snap.settled,true);assert.equal(snap.yangShare_wad,'500000000000000000');
 // Invalid amounts and a non-existent historical series cannot broadcast.
 const count=transactions;ctx.api.W.acct=accounts[0];
 assert.equal(ctx.api.exactAmount('0.000000000000000001'),1n);
 walletChain=97;await ctx.api.doExit('pair');assert.equal(transactions,count);assert.match(ctx.api.W.msg,/Switch wallet/);walletChain=11155111;
 reportedAccount=accounts[1];await ctx.api.doExit('pair');assert.equal(transactions,count);assert.match(ctx.api.W.msg,/已改变/);reportedAccount=null;
 ctx.api.exitForm.yang='-1';await ctx.api.doExit('settled');assert.equal(transactions,count);
 ctx.api.exitForm.yang='2';ctx.api.exitForm.series='1';await ctx.api.doExit('settled');assert.equal(transactions,count);assert.match(ctx.api.W.msg,/Unknown series/);
 ctx.api.exitForm.series='0';ctx.api.exitForm.yin='1';await ctx.api.doExit('settled');assert.match(ctx.api.W.msg,/^✓/);
 ctx.api.W.acct=accounts[1];ctx.api.exitForm.yang='0';ctx.api.exitForm.yin='1';await ctx.api.doExit('settled');assert.match(ctx.api.W.msg,/^✓/);
 const call=async(to,sig,...a)=>BigInt(await rpc('eth_call',[{to,data:data(sig,...a)},'latest']));
 assert.equal(await call(vault,'liabilities()'),0n);assert.equal(await call(asset,'balanceOf(address)',vault),0n);
 assert.equal(await call(asset,'balanceOf(address)',accounts[1]),499750000000000000n);
 assert.equal(await call(asset,'balanceOf(address)',accounts[0]),99498250000000000000n);
 assert.equal(await call(asset,'balanceOf(address)',accounts[2]),2000000000000000n);
 assert.equal(await call(vault,'currentId()'),0n);
 console.log(JSON.stringify({status:'PASS',environment:'isolated local EVM; test-only relay feeder; no public Bitcoin reorg',transactions,checks:['branch revision restarts 144-height window','premature sealing rejected','keeper seals and closes','mint rejected after closure','browser exit works with no indexer','wrong chain/account/amount/series cannot send','both holders redeem unequal claims','exact fees; zero liabilities; no successor']},null,2));
 if(process.env.DRILL_PREVIEW_PORT){
  const previewPort=Number(process.env.DRILL_PREVIEW_PORT);assert.ok(Number.isInteger(previewPort)&&previewPort>1024&&previewPort<65536);
  const localRelease={...d,rpc:url,vaults:[{...v,symbol:'LOCAL DEMO'}]};
  // Generate an ephemeral, clearly labelled read-only page. No production release address is modified.
  const page=html.replace(/  const RELEASES=.*;/,'  const RELEASES='+JSON.stringify({sepolia:localRelease})+';')
   .replace(/<select id="deploymentSelect">.*?<\/select>/,'<select id="deploymentSelect"><option value="sepolia">本地退出演练 · 非公网</option></select>')
   .replace('const eth=()=>window.ethereum;','const eth=()=>null;')
   .replace('<body>','<body><div style="padding:12px;background:#714500;color:white;font-size:16px">本地退出演练 · 测试专用区块头输入 · 已完成赎回 · 只读展示，无钱包连接；不是公网部署或真实比特币重组。</div>');
  const preview=http.createServer((req,res)=>{
   if(req.url==='/head'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({ts:Math.floor(Date.now()/1000),genesisTs:0,err:'本地演练：故意不运行索引器',source:'bitcoin'}));}
   if(req.url!=='/'){res.writeHead(404);return res.end();}
   res.setHeader('content-type','text/html; charset=utf-8');res.end(page);
  });
  await new Promise(r=>preview.listen(previewPort,'127.0.0.1',r));
  const timer=setInterval(()=>rpc('evm_mine',[]).catch(()=>{}),5000);
  console.log('Read-only local drill preview: http://localhost:'+previewPort+' (PID '+process.pid+')');
  await new Promise(r=>{process.once('SIGTERM',r);process.once('SIGINT',r);});
  clearInterval(timer);preview.closeAllConnections();await new Promise(r=>preview.close(r));
 }

}finally{if(anvil.exitCode===null){anvil.kill('SIGTERM');await new Promise(r=>anvil.once('exit',r));}}
