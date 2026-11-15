import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const helpers=html.slice(html.indexOf('  const ADDRESS='),html.indexOf('  // END VERIFICATION HELPERS'));
const ctx=vm.createContext({URL,Date});vm.runInContext(helpers+'\nthis.api={endpoint,stairPoints,verifySnapshot,healthyHead};',ctx);
const {endpoint,stairPoints,verifySnapshot,healthyHead}=ctx.api;
const word=n=>'0x'+BigInt.asUintN(256,BigInt(n)).toString(16).padStart(64,'0'),addr=n=>'0x'+String(n).repeat(40),now=1800000000000;
function fixture({chain=11155111,reorg=false,old=false,share=600000000000000000n,wrongBinding=false}={}){
 const d={chainId:11155111,index:addr(1),relay:addr(2)},v={address:addr(3),asset:addr(4),notional:'1000000000000000'};
 const c={contract:d.index,observedAt:100,S_wad:'-5',indexer_S_wad:'-5',lastHeight:967900,lastHash:word(42),indexerHash:word(42)};
 const metadata={...v,chainId:d.chainId,notional:0.001,notional_wad:v.notional,seriesId:0,yang:addr(5),yin:addr(6),s0_wad:'-8',startHeight:967826,settlementHeight:972145,settled:false,yangShare:0.6,yangShare_wad:'600000000000000000'};
 const h={ts:now/1000,chain:{...c,vaults:[metadata]}};const calls=[];let pinned=0;
 const rpc=async(method,params)=>{
  calls.push({method,params});
  if(method==='eth_chainId')return '0x'+chain.toString(16);
  if(method==='eth_getBlockByNumber'){if(params[0]!=='latest')pinned++;return {number:params[0]==='latest'?'0x66':params[0],hash:word(reorg&&pinned>1?2:1),timestamp:'0x'+(now/1000-(old?300:20)).toString(16)};}
  if(method==='eth_call'){
   const {to,data}=params[0];const sig=data.slice(0,10);
   if(to===d.index)return {'0x4be1c796':word(-5),'0x25159aa9':word(967900),'0x3fa21806':word(42),'0xb59589d1':word(d.relay)}[sig];
   if(to===v.address)return {'0xdbc1faef':word(share),'0xe00dd161':word(0),'0x2986c0e5':word(wrongBinding?addr(7):d.index),'0x38d52e0f':word(v.asset),'0x858dccb3':word(v.notional),'0xdc22cb6a':'0x'+[addr(5),addr(6),-8,967826,972145,0,0].map(n=>word(n).slice(2)).join('')}[sig];
  }
  throw Error('unexpected call');
 };
 return {rpc,d,v,h,calls,metadata};
}
test('staircase preserves every jump as a vertical segment',()=>{
 const prices=[3,3,5,2,2],points=stairPoints(t=>prices[t],0,4);assert.deepEqual(JSON.parse(JSON.stringify(points)),[[0,3],[2,3],[2,5],[3,5],[3,2],[4,2]]);
 for(let i=1;i<points.length;i++)assert.ok(points[i][0]===points[i-1][0]||points[i][1]===points[i-1][1]);
});
test('source endpoints reject credentials and active/mixed-content URLs',()=>{
 assert.equal(endpoint('http://localhost:8793/'),'http://localhost:8793');assert.equal(endpoint('https://example.com/api/'),'https://example.com/api');
 for(const s of ['javascript:alert(1)','https://user:pass@host','https://host/?key=secret','http://example.com','https://host/#x'])assert.throws(()=>endpoint(s));
});
test('independent snapshot compares exact signed integers, share and bindings at one EVM block',async()=>{
 const f=fixture(),r=await verifySnapshot(f.rpc,f.d,f.v,f.h,now,now);assert.equal(r.status,'matched');assert.equal(r.S_wad,'-5');assert.equal(r.yangShare_wad,'600000000000000000');assert.equal(r.block,100);
 assert.ok(f.calls.filter(c=>c.method==='eth_call').every(c=>c.params[1]==='0x64'));
});
test('one wei share or S mismatch cannot be rounded into agreement',async()=>{
 const f=fixture({share:600000000000000001n});f.h.chain.S_wad='-6';const r=await verifySnapshot(f.rpc,f.d,f.v,f.h,now,now);assert.equal(r.status,'mismatch');assert.ok(r.mismatches.includes('S_wad'));assert.ok(r.mismatches.includes('yangShare_wad'));
});
test('bad hash, token and notional metadata are detected',async()=>{
 const f=fixture();f.h.chain.indexerHash=word(43);Object.assign(f.metadata,{yang:addr(7),notional_wad:'1'});const r=await verifySnapshot(f.rpc,f.d,f.v,f.h,now,now);assert.equal(r.status,'mismatch');assert.ok(r.mismatches.includes('indexer S/hash'));assert.ok(r.mismatches.includes('yang'));assert.ok(r.mismatches.includes('notional_wad'));
});
for(const [option,error] of [[{chain:97},/chain mismatch/],[{old:true},/stale/],[{reorg:true},/reorg/],[{wrongBinding:true},/binding/]])test('reject invalid RPC snapshot '+JSON.stringify(option),async()=>{const f=fixture(option);await assert.rejects(verifySnapshot(f.rpc,f.d,f.v,f.h,now,now),error);});
test('failed, stale or absent indexer still permits direct read, never an agreement badge',async()=>{
 for(const h of [{},{ts:now/1000,err:'429'},{ts:now/1000-200}, {...fixture().h,chain:{err:'RPC offline'}}]){
  const f=fixture(),r=await verifySnapshot(f.rpc,f.d,f.v,h,now,now);assert.equal(r.status,'direct-only');assert.equal(r.block,102);
 }
 const f=fixture();assert.equal(healthyHead(f.h,now-31000,now),false);
});
test('published terminal has no remote script, stylesheet or build dependency',()=>{
 assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+rel="stylesheet"/);assert.match(html,/data-type="steps"/);
 new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
});
test('lost indexer or RPC clears the old on-chain cells instead of retaining green results',()=>{
 const cells=new Map(),get=id=>{if(!cells.has(id))cells.set(id,{innerHTML:'old green result',textContent:'old green result',hidden:false});return cells.get(id);};
 const render=html.slice(html.indexOf('  function renderTaiji(){'),html.indexOf('  // ---- wallet:'));
 for(const h of [{},{ts:now/1000,chain:{err:'RPC unavailable'}},{ts:now/1000-300,chain:{}}]){
  const c=vm.createContext({$:get,renderExit:()=>{},HEAD:h,headReceived:now,healthyHead:(h,r)=>healthyHead(h,r,now),curVault:()=>({address:addr(3)})});vm.runInContext(render+'\nrenderTaiji();',c);
  assert.equal(get('tYYwrap').hidden,true);assert.match(get('tjChain').textContent,/未能提供新鲜快照/);assert.equal(get('cChain').textContent,'⚠');assert.equal(get('tjWallet').textContent,'等待有效金库数据');
 }
});
test('green direct-read badge expires and disappears on RPC failure or a changed vault',()=>{
 const f=fixture(),r={status:'matched',checkedAt:Date.now(),index:f.d.index,vault:f.v.address};
 const code=html.slice(html.indexOf('  function proofStatus(){'),html.indexOf('  function walletVerified('));
 const c=vm.createContext({checkResult:r,checking:false,HEAD:{...f.h,ts:Date.now()/1000},headReceived:Date.now(),Date,healthyHead,same:(a,b)=>String(a).toLowerCase()===String(b).toLowerCase(),curVault:()=>f.v});vm.runInContext(code+'\nthis.status=proofStatus;',c);
 assert.equal(c.status().status,'matched');r.checkedAt-=61000;assert.equal(c.status().status,'stale');r.checkedAt=Date.now();c.HEAD.err='429';assert.equal(c.status().status,'direct-only');delete c.HEAD.err;f.v.address=addr(9);assert.equal(c.status().status,'direct-only');r.status='error';r.error='RPC failed';assert.equal(c.status().status,'error');
});
test('an indexer cannot bypass the wallet gate by declaring a legacy source',()=>{
 const code=html.slice(html.indexOf('  function walletVerified('),html.indexOf('  function renderVerification('));
 for(const source of ['bitcoin','bsc',undefined]){
  const f=fixture(),c=vm.createContext({HEAD:{source,chain:{contract:f.d.index}},checkResult:null,proofStatus:()=>({status:'matched'}),same:(a,b)=>String(a).toLowerCase()===String(b).toLowerCase()});
  vm.runInContext(code+'\nthis.allowed=walletVerified;',c);assert.equal(c.allowed(f.metadata),false);
  c.checkResult={...f.metadata,index:f.d.index,vault:f.v.address};assert.equal(c.allowed(f.metadata),true);
  f.metadata.asset=addr(9);assert.equal(c.allowed(f.metadata),false);
 }
});

test('historical redemptions use that series fixed share, never the current live share',async()=>{
 const f=fixture(),original=f.rpc;
 f.rpc=async(m,p)=>{
  if(m==='eth_call'&&p[0].to===f.v.address){
   if(p[0].data==='0xe00dd161')return word(3);
   if(p[0].data.startsWith('0xdc22cb6a')){
    assert.equal(p[0].data,'0xdc22cb6a'+word(2).slice(2));
    return '0x'+[addr(7),addr(8),-8,967826,972145,1,700000000000000000n].map(n=>word(n).slice(2)).join('');
   }
  }
  return original(m,p);
 };
 const r=await verifySnapshot(f.rpc,f.d,f.v,{},0,now,'2');
 assert.equal(r.status,'direct-only');assert.equal(r.currentId,3);assert.equal(r.seriesId,2);assert.equal(r.settled,true);
 assert.equal(r.yangShare_wad,'700000000000000000');assert.equal(r.yang,addr(7));
});
test('perp wallet actions only for pools in the built-in release list, never from indexer data',()=>{
 const src=html.slice(html.indexOf('  function releasedPool('),html.indexOf('  const myIdsKey='));
 const same=(a,b)=>!!a&&!!b&&a.toLowerCase()===b.toLowerCase();
 const RELEASES={x:{chainId:11155111,accountPools:[{address:addr(7),asset:addr(8),k_wad:'11500000000000000000'}]},y:{chainId:97}};
 const c=vm.createContext({RELEASES,same,PERP_RELEASES:[]});vm.runInContext(src+'\nthis.f=releasedPool;',c);
 assert.equal(c.f(addr(9)),null);
 const hit=c.f(addr(7).toUpperCase().replace('0X','0x'));
 assert.equal(hit.chainId,11155111);assert.equal(hit.asset,addr(8));
});
test('pool and account payloads are validated before rendering',()=>{
 const src=html.slice(html.indexOf('  const WAD_STR='),html.indexOf('  function validateHead('));
 const c=vm.createContext({ADDRESS:/^0x[0-9a-fA-F]{40}$/});vm.runInContext(src+'\nthis.p=validatePool;this.a=validateAccount;',c);
 const pool={address:addr(1),asset:addr(2),index:addr(3),k_wad:'1',yin_wad:'1',yang_wad:'1',matched_wad:'1',idle_wad:'0',buffer_wad:'0',badDebt_wad:'0',balance_wad:'2',lastS_wad:'-3',epoch:6,delay:2,feeBps:30,pendingEpochs:0,nextPricingHeight:1,accountsCreated:0,annualVol:0.1,idleSide:null};
 c.p(pool);
 assert.throws(()=>c.p({...pool,yin_wad:'<img src=x>'}));
 assert.throws(()=>c.p({...pool,address:'javascript:1'}));
 const acct={owner:addr(4),side:'yang',status:'open',principal_wad:'1',value_wad:'1',pnl_wad:'0',overshoot_wad:'0',enterEpoch:6,exitEpoch:null,multiple:1};
 assert.equal(c.a(acct).side,'yang');
 assert.throws(()=>c.a({...acct,status:'<b>'}));
 assert.throws(()=>c.a({...acct,owner:'"><script>'}));
});
test('perp wallet errors are shown in words a holder can act on',()=>{
 const src=html.slice(html.indexOf('  const PERP_REASONS='),html.indexOf('  async function perpSend('));
 const c=vm.createContext({TextDecoder,Uint8Array,parseInt,String,Object});vm.runInContext(src+'\nthis.f=perpError;',c);
 const enc=s=>'0x08c379a0'+'20'.padStart(64,'0')+s.length.toString(16).padStart(64,'0')+Buffer.from(s).toString('hex').padEnd(64,'0');
 assert.equal(c.f({code:4001,message:'MetaMask Tx Signature: User denied transaction signature.'}),'已在钱包中取消');
 assert.match(c.f({message:'RPC eth_sendRawTransaction: insufficient funds for gas * price + value'}),/gas 余额不足/);
 assert.equal(c.f(new Error('Switch wallet to BNB Smart Chain Testnet')),'请先把钱包切换到 BNB Smart Chain Testnet');
 assert.match(c.f({message:'Internal JSON-RPC error.',data:{message:'execution reverted: not claimable'}}),/还不能领取/);
 assert.match(c.f({message:'execution reverted',data:enc('entry pending')}),/进场还没定价/);
 assert.match(c.f({message:'execution reverted',data:{data:enc('relay stale')}}),/不够新/);
 assert.equal(c.f({message:'execution reverted',data:enc('something new')}),'合约拒绝：something new');
});
test('blockAtTick rejects XSS or non-integer block numbers and terminal sets CSP',async()=>{
 assert.match(html,/<meta http-equiv="Content-Security-Policy" content="object-src 'none'; base-uri 'none'; form-action 'none'">/);
 const src=html.slice(html.indexOf('  let blockCache=new Map();'),html.indexOf("  cv.addEventListener('click'"));
 let payload={block:'<img src=x onerror=alert(1)>',hash:'aa'.repeat(32)};
 const c=vm.createContext({GENESIS:1000,API:'http://localhost:8793',Map,Number,String,esc:s=>String(s).replace(/[<>&"]/g,'_'),fetchTimed:async()=>({json:async()=>payload})});
 vm.runInContext(src+'\nthis.f=blockAtTick;',c);
 await assert.rejects(()=>c.f(5),/Invalid blockAt payload/);
 payload={block:123,hash:'javascript:alert(1)'};
 await assert.rejects(()=>c.f(6),/Invalid blockAt payload/);
 payload={block:800000,hash:'AA'.repeat(32),ts:1005};
 const ok=await c.f(7);assert.equal(ok.block,800000);assert.equal(ok.hash,'aa'.repeat(32));
});
test('appendPX rejects truncated buffers and NaN/non-positive float samples',()=>{
 const src=html.slice(html.indexOf('  let PX=new Float32Array(0)'),html.indexOf('  async function fetchSeconds('));
 const c=vm.createContext({Float32Array,Math,Number});vm.runInContext(src+'\nthis.append=appendPX;this.len=()=>PXN;',c);
 assert.throws(()=>c.append(new Uint8Array(3).buffer),/Invalid \/seconds buffer/);
 for(const bad of [NaN,Infinity,-1,0,1e20]){
  const f=new Float32Array([100,bad]);
  assert.throws(()=>c.append(f.buffer),/Invalid \/seconds price sample/);
 }
 assert.equal(c.len(),0);
 c.append(new Float32Array([100,101.5]).buffer);
 assert.equal(c.len(),2);
});
test('readZk rejects RPC transport or partial optional-selector failures instead of faking empty queue',async()=>{
 const src=html.slice(html.indexOf('  // ---------------------------------------------------------------- ZK index'),html.indexOf('  async function doExit('));
 let mode='rate-limit';
 const fetchTimed=async(_url,opts)=>{
  const req=JSON.parse(opts.body);
  if(req.method==='eth_chainId')return {json:async()=>({jsonrpc:'2.0',id:req.id,result:'0xaa36a7'})};
  if(req.method==='eth_getBlockByNumber')return {json:async()=>({jsonrpc:'2.0',id:req.id,result:{number:'0x64',hash:word(1),timestamp:'0x65000000'}})};
  const sel=req.params[0].data.slice(0,10);
  if(['0x6faf954b','0xe7c51f1b','0xd62aad29'].includes(sel)){
   if(mode==='rate-limit')return {json:async()=>({jsonrpc:'2.0',id:req.id,error:{code:-32005,message:'Too Many Requests'}})};
   if(mode==='partial'&&sel==='0x6faf954b')return {json:async()=>({jsonrpc:'2.0',id:req.id,error:{code:3,message:'execution reverted'}})};
   if(mode==='header-only')return {json:async()=>({jsonrpc:'2.0',id:req.id,error:{code:3,message:'execution reverted'}})};
   return {json:async()=>({jsonrpc:'2.0',id:req.id,result:word(sel==='0xd62aad29'?86400:0)})};
  }
  if(sel==='0x2755cd2d')return {json:async()=>({jsonrpc:'2.0',id:req.id,result:'0x'+[1,800100,0x1d00ffff,1700000000].map(n=>word(n).slice(2)).join('')})};
  return {json:async()=>({jsonrpc:'2.0',id:req.id,result:word(100)})};
 };
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:''});return nodes.get(id);};
 const c=vm.createContext({fetchTimed,WORD:/^0x[0-9a-f]{64}$/i,$:get,esc:s=>String(s),short:s=>s,BigInt,Number,String,Date,Math,Promise});
 vm.runInContext(src+'\nthis.read=readZk;this.state=()=>({ZK,zkError});',c);
 await c.read();assert.equal(c.state().ZK,null);assert.match(c.state().zkError,/Too Many Requests/);
 mode='partial';await c.read();assert.equal(c.state().ZK,null);assert.match(c.state().zkError,/部分缺失/);
 mode='header-only';await c.read();assert.equal(c.state().zkError,null);assert.equal(c.state().ZK.window,0);assert.equal(c.state().ZK.height,800100);
});
test('lookAccount verifies released pools directly via pinned RPC instead of trusting indexer HTTP',async()=>{
 const relSrc=html.slice(html.indexOf('  function releasedPool('),html.indexOf('  const myIdsKey='));
 const acctSrc=html.slice(html.indexOf('  async function readPerpAccountOnChain('),html.indexOf("  $('pjLook').onclick="));
 const valSrc=html.slice(html.indexOf('  const WAD_STR='),html.indexOf('  function validateHead('));
 const pool=addr(7);let httpCalled=false;
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='pjPool'?pool:'1',innerHTML:'',textContent:''});return nodes.get(id);};
 const rpcCalls=[];
 const provider={request:async({method,params})=>{
  rpcCalls.push({method,params});
  if(method==='eth_chainId')return '0xaa36a7';
  if(method==='eth_getBlockByNumber')return {number:'0x64',hash:word(9)};
  const d=params[0].data;
  if(d.startsWith('0xf2a40db8'))return '0x'+[addr(4),1,10,0,10n**18n].map(x=>word(x).slice(2)).join('');
  if(d.startsWith('0xcadf338f'))return word(12n*10n**17n);
  if(d.startsWith('0xb68f590f'))return word(12n*10n**17n);
  if(d.startsWith('0xa2e04c67'))return '0x'+[0,0,1].map(x=>word(x).slice(2)).join('');
  if(d==='0x054f7d9c')return word(0);
  if(d.startsWith('0x513bed12'))return word(0);
  if(d.startsWith('0xf9f3de7e'))return '0x'+[0,0,1].map(x=>word(x).slice(2)).join('');
  throw Error('unexpected '+d);
 }};
 const c=vm.createContext({ADDRESS:/^0x[0-9a-fA-F]{40}$/,WORD:/^0x[0-9a-f]{64}$/i,word:v=>BigInt(v),signedWord:v=>BigInt.asIntN(256,BigInt(v)).toString(),
  addressWord:v=>'0x'+v.slice(-40).toLowerCase(),same:(a,b)=>String(a).toLowerCase()===String(b).toLowerCase(),
  RELEASES:{s:{chainId:11155111,rpc:'https://rpc.example',accountPools:[{address:pool,asset:addr(8),k_wad:'1'}]}},PERP_RELEASES:[],
  W:{acct:addr(4),chainId:11155111},eth:()=>provider,rpcURLs:{},ZK_RELEASE:{chainId:11155111,rpc:'https://rpc.example'},walletNetworks:{},
  exitRPC:()=>{throw Error('should use connected wallet RPC');},API:'http://localhost:8793',fetchTimed:async()=>{httpCalled=true;throw Error('indexer must not be trusted');},
  $:get,esc:s=>String(s),short:s=>s,wad:s=>Number(s)/1e18,fmtW:s=>(Number(s)/1e18).toFixed(4),cls:()=>'up',BigInt,Number,String,Promise,Object});
 vm.runInContext(valSrc+relSrc+acctSrc+'\nthis.look=lookAccount;',c);
 await c.look();
 assert.equal(httpCalled,false);
 assert.match(get('pjAcct').innerHTML,/RPC 直读 · 区块 #100/);
 assert.ok(rpcCalls.filter(x=>x.method==='eth_call').every(x=>x.params[1]==='0x64'));
});
