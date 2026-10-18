import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('  const W={acct:'),html.indexOf('  async function send('));
const address='0x'+'55'.repeat(20);
function fixture({order=['other','meta'],reject,pending=false,legacy=true}={}){
 const listeners=new Map(),calls={meta:[],other:[]};let resolveAccounts;
 const make=name=>({request:async({method})=>{
  calls[name].push(method);
  if(method==='eth_requestAccounts'){
   if(reject)throw {code:reject,message:reject===4001?'User rejected the request.':'Request already pending'};
   if(pending)return new Promise(resolve=>{resolveAccounts=resolve;});return [address];
  }
  if(method==='eth_chainId')return '0xaa36a7';
  throw Error('unexpected method '+method);
 },on:()=>{}});
 const providers={meta:make('meta'),other:make('other')};
 const win={addEventListener:(type,fn)=>{if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
  dispatchEvent:event=>{for(const fn of listeners.get(event.type)||[])fn(event);}};
 Object.defineProperty(win,'ethereum',{get:()=>legacy?providers.other:undefined}); // competing getter-only injection
 const announce=(name,uuid=name)=>win.dispatchEvent({type:'eip6963:announceProvider',detail:{info:{uuid,rdns:name==='meta'?'io.metamask':'com.other.wallet',name:name==='meta'?'MetaMask':'Other Wallet'},provider:providers[name]}});
 win.addEventListener('eip6963:requestProvider',()=>{for(const name of order)announce(name);});
 const c=vm.createContext({window:win,Event:class {constructor(type){this.type=type;}},
  setTimeout:(fn,ms)=>setTimeout(fn,ms===200?0:ms),HEAD:{chain:{}},curVault:()=>null,
  renderWallet:()=>{},renderPerpWallet:()=>{}});
 vm.runInContext(source+'\nthis.api={W,connect,eth,chooseWallet,connectionError};',c);
 return {...c.api,calls,providers,announce,resolve:()=>resolveAccounts([address])};
}
const target={address:'0x'+'11'.repeat(20),chainId:11155111,wallet:'metamask'};
for(const order of [['other','meta'],['meta','other']])test('connects MetaMask despite a competing getter-only provider: '+order.join(','),async()=>{
 const f=fixture({order});await f.connect(target);assert.equal(f.W.acct,address);assert.equal(f.W.walletName,'MetaMask');assert.equal(f.eth(),f.providers.meta);
 assert.ok(f.calls.meta.includes('eth_requestAccounts'));assert.equal(f.calls.other.length,0);assert.equal(f.W.connecting,false);
});
test('does not silently connect a different announced wallet when MetaMask is absent',async()=>{
 const f=fixture({order:['other']});await f.connect(target);assert.match(f.W.msg,/未发现 MetaMask/);assert.equal(f.calls.other.length,0);assert.equal(f.W.acct,null);
});
test('a missing provider gives an actionable Chinese message',async()=>{
 const f=fixture({order:[],legacy:false});await f.connect(target);assert.match(f.W.msg,/没有钱包/);assert.equal(f.W.connecting,false);
});
for(const [reject,error] of [[4001,/连接已取消/],[-32002,/待处理请求/]])test('connection error '+reject+' explains the toolbar action',async()=>{
 const f=fixture({reject});await f.connect(target);assert.match(f.W.msg,error);assert.match(f.W.msg,/工具栏/);assert.equal(f.W.connecting,false);assert.equal(f.W.acct,null);
});
test('shows pending authorization and suppresses duplicate connection requests',async()=>{
 const f=fixture({pending:true});const first=f.connect(target);await Promise.resolve();await Promise.resolve();
 assert.equal(f.W.connecting,true);assert.match(f.W.msg,/等待 MetaMask 授权/);await f.connect(target);
 assert.equal(f.calls.meta.filter(m=>m==='eth_requestAccounts').length,1);f.resolve();await first;assert.equal(f.W.connecting,false);
});
test('late announcements cannot replace a connected provider',async()=>{
 const f=fixture();await f.connect(target);f.announce('other','late-wallet');assert.equal(await f.chooseWallet(true),f.providers.meta);assert.equal(f.calls.other.length,0);
});
