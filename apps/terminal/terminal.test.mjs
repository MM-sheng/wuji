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
 const c=vm.createContext({RELEASES,same});vm.runInContext(src+'\nthis.f=releasedPool;',c);
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
