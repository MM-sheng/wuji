import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BitcoinAPI, step } from './bitcoin.mjs';
import { network, assertChain } from './networks.mjs';
import { rpcRequest } from './evm-rpc.mjs';
import { readFrozenExit } from './frozen-exit.mjs';
const api=new BitcoinAPI();
const genesis=Number(process.env.GENESIS_HEIGHT), port=Number(process.env.PORT||8789);
if(!Number.isSafeInteger(genesis)||genesis<1) throw Error('GENESIS_HEIGHT required');
const dir=process.env.DATA_DIR||path.join(path.dirname(fileURLToPath(import.meta.url)),'data');fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,`bitcoin-${genesis}.json`);
let rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
let tip=genesis-1, tipHash=null, tipTs=null, error=null, halted=false, chain=null, genesisTs=0;
const price=u=>100*Math.exp(u*1.2e-5);
const save=()=>{fs.writeFileSync(file+'.tmp',JSON.stringify(rows));fs.renameSync(file+'.tmp',file);};
const hex=n=>'0x'+n.toString(16);
const RPC=(process.env.RPC||'https://bsc-testnet-rpc.publicnode.com').split(',')[0];
const CONTRACT=process.env.CONTRACT, FACTORY=process.env.FACTORY;
const CHAIN_ID=Number(process.env.CHAIN_ID||97);
const NETWORK=network(CHAIN_ID);
const rpc=(method,params)=>rpcRequest(RPC,method,params);
const call=async(to,data,block='latest')=>rpc('eth_call',[{to,data},block]);
const toInt=h=>{const v=BigInt(h);return v>=1n<<255n?v-(1n<<256n):v;};
const SEL={"S": "0x4be1c796", "lastHeight": "0x25159aa9", "yangShare": "0xdbc1faef", "currentId": "0xe00dd161", "series": "0xdc22cb6a", "asset": "0x38d52e0f", "liabilities": "0xb4add307", "balanceOf": "0x70a08231"};
async function readVault(V,at) {
  const c = {};
  const read=(to,data)=>call(to,data,at);
  const [ys, cid, asset, liab] = await Promise.all([read(V, SEL.yangShare), read(V, SEL.currentId), read(V, SEL.asset), read(V, SEL.liabilities)]);
  const id = Number(BigInt(cid)); const assetAddr = '0x' + asset.slice(26);
  const [sr, bal] = await Promise.all([read(V, SEL.series + id.toString(16).padStart(64, '0')), read(assetAddr, SEL.balanceOf + V.slice(2).toLowerCase().padStart(64, '0'))]);
  const w = k => '0x' + sr.slice(2 + 64 * k, 2 + 64 * (k + 1));
  c.v = { address: V, asset: assetAddr, seriesId: id, yang: '0x' + w(0).slice(26), yin: '0x' + w(1).slice(26), s0_wad: toInt(w(2)).toString(), startHeight: Number(BigInt(w(3))), settlementHeight: Number(BigInt(w(4))), settled: BigInt(w(5)) !== 0n, yangShare: Number(BigInt(ys)) / 1e18, yangShare_wad: BigInt(ys).toString(),
    balance: Number(BigInt(bal)) / 1e18, liabilities: Number(BigInt(liab)) / 1e18, chainId: CHAIN_ID, networkName: NETWORK.name, explorer: NETWORK.explorer };
  const sym = await read(V, '0xbf911794').catch(() => null);                                          // collateralSymbol()
  if (sym) { try { const off = Number(BigInt('0x' + sym.slice(2, 66))), len = Number(BigInt('0x' + sym.slice(2 + off * 2, 2 + off * 2 + 64))); c.v.symbol = Buffer.from(sym.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2), 'hex').toString(); } catch (e) {} }
  const notional = await read(V, '0x858dccb3');
  c.v.notional = Number(BigInt(notional)) / 1e18;c.v.notional_wad=BigInt(notional).toString();
  c.v.balance_wad=BigInt(bal).toString();c.v.liabilities_wad=BigInt(liab).toString();c.v.solvent=BigInt(bal)>=BigInt(liab);
  if(process.env.FROZEN_EXIT==='1')c.v.closed=BigInt(await read(V,'0x597e1fb5'))===1n;
  return c.v;
}
async function pollChain(){
 if(!CONTRACT)return;
 try{
  assertChain(await rpc('eth_chainId',[]),CHAIN_ID);
  const block=await rpc('eth_getBlockByNumber',['latest',false]);
  const at=block.number;
  const [s,last,genesisOnchain,lastHash]=await Promise.all([call(CONTRACT,SEL.S,at),call(CONTRACT,SEL.lastHeight,at),call(CONTRACT,'0x207c8a4c',at),call(CONTRACT,'0x3fa21806',at)]);
  if(Number(BigInt(genesisOnchain))!==genesis)throw Error('Bitcoin genesis configuration mismatch');
  const lastHeight=Number(BigInt(last));const row=rows[lastHeight-genesis];
  const expected=lastHeight===genesis-1?'0':row?(BigInt(row.U)*12000000000000n).toString():undefined;
  const S_wad=toInt(s).toString();const expectedHash=lastHeight===genesis-1?'0x'+'0'.repeat(64):row?'0x'+row.internalHash:undefined;const agree=expected===S_wad&&expectedHash===lastHash;
  const c={contract:CONTRACT,lastHeight,lastBlock:lastHeight,lastHash,indexerHash:expectedHash,S_wad,indexer_S_wad:expected,agree,reconciliation:expected===undefined?'index-behind':agree?'matched':'mismatch',S:Number(toInt(s))/1e18,price:100*Math.exp(Number(toInt(s))/1e18),observedAt:parseInt(at,16)};
  if(process.env.RELAY_TIMESTAMPS==='1'){
   const [address,fresh,maxAge]=await Promise.all([call(CONTRACT,'0xb59589d1',at),call(CONTRACT,'0x8647058f',at),call(CONTRACT,'0xf0273767',at)]);
   const relayAddress='0x'+address.slice(-40);
   const [hash,height]=await Promise.all([call(relayAddress,'0xf6b36551',at),call(relayAddress,'0x8cef3d2a',at)]);
   const time=await call(relayAddress,'0x76fa0b8a'+hash.slice(2),at);
   c.relay={address:relayAddress,fresh:BigInt(fresh)===1n,maxAge:Number(BigInt(maxAge)),height:Number(BigInt(height)),timestamp:Number(BigInt(time))};
  }
  if(FACTORY){const count=Number(BigInt(await call(FACTORY,'0x06661abd',at)));c.vaults=[];for(let i=0;i<count;i++){const v='0x'+(await call(FACTORY,'0x8c64ea4a'+i.toString(16).padStart(64,'0'),at)).slice(26);c.vaults.push(await readVault(v,at));}c.vault=c.vaults[0];}
  if(process.env.FROZEN_EXIT==='1')c.frozenExit=await readFrozenExit((to,data)=>call(to,data,at),CONTRACT,c.relay.address);
  if((await rpc('eth_getBlockByNumber',[at,false]))?.hash!==block.hash)throw Error('EVM reorg during snapshot');
  c.observedHash=block.hash;chain=c;
 }catch(e){chain={contract:CONTRACT,err:e.message};}
}
async function sync(){
 if(halted)return;
 const nextTip=await api.tip();
 const tipBlock=await api.at(nextTip);const tipStep=step(tipBlock.header);if(tipStep.hash!==tipBlock.hash)throw Error("tip hash mismatch");tip=nextTip;tipHash=tipStep.hash;tipTs=tipStep.timestamp;
 if(!genesisTs)genesisTs=step((await api.at(genesis)).header).timestamp;
 if(rows.length){const last=rows.at(-1);if((await api.hashAt(last.height))!==last.hash){halted=true;throw Error('deep Bitcoin reorg: finalized history changed');}}
 const final=tip-6;
 let previous=rows.at(-1)?.hash;
 for(let h=genesis+rows.length;h<=final;h++){
   // Confirm the six descendants link to the candidate before publishing it.
   const block=await api.at(h);const s=step(block.header);
   if(s.hash!==block.hash)throw Error('source header hash mismatch');
   const parent=Buffer.from(block.header.slice(8,72),'hex').reverse().toString('hex');
   if(previous&&parent!==previous){halted=true;throw Error('deep Bitcoin reorg: broken finalized linkage');}
   let hash=s.hash, confirmedAt=s.timestamp;
   for(let k=1;k<=6;k++){
     const child=await api.at(h+k);const cs=step(child.header);
     if(cs.hash!==child.hash||Buffer.from(child.header.slice(8,72),'hex').reverse().toString('hex')!==hash)throw Error('Bitcoin tip changed during confirmation check');
     hash=cs.hash;confirmedAt=Math.max(confirmedAt,cs.timestamp);
   }
   const U=(rows.at(-1)?.U||0)+s.delta;
   rows.push({height:h,header:block.header,...s,U,ts:Math.max(rows.at(-1)?.ts||genesisTs,confirmedAt)});
   previous=s.hash;save();
 }
}
function at(ts){let lo=0,hi=rows.length-1,answer=-1;while(lo<=hi){const m=(lo+hi)>>1;if(rows[m].ts<=ts){answer=m;lo=m+1;}else hi=m-1;}return answer;}
function head(){const last=rows.at(-1);return {source:'bitcoin',block:last?.height??genesis-1,height:last?.height??genesis-1,hash:last?.hash,ts:Math.floor(Date.now()/1000),blockTs:last?.timestamp,genesisTs,genesisBlock:genesis,genesisHeight:genesis,blocks:rows.length,U:last?.U||0,S:(last?.U||0)*1.2e-5,price:price(last?.U||0),chainHead:tip,tipHash,tipTs,behind:Math.max(0,tip-6-(last?.height??genesis-1)),synced:!error&&!halted,confirmations:6,unit:1.2e-5,sigma:1.2e-5*Math.sqrt(32*65535/12),err:error,halted,chain};}
const staticDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../apps/terminal');
http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://local'),q=u.searchParams;
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
 if(req.method!=='GET'){res.writeHead(405,{'Allow':'GET, OPTIONS'});return res.end();}
 const json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(v));};
 try{
  if(u.pathname==='/head')return json(head());
  if(u.pathname==='/seconds'){
   const from=Number(q.get('from')),to=Number(q.get('to')),len=to-from+1;
   if(!Number.isSafeInteger(len)||len<0||len>2_000_000)return json({error:'range'},400);
   const buf=Buffer.alloc(len*4);let i=at(from);
   for(let k=0;k<len;k++){while(i+1<rows.length&&rows[i+1].ts<=from+k)i++;buf.writeFloatLE(price(rows[i]?.U||0),k*4);}
   res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});return res.end(buf);
  }
  if(u.pathname==='/blockAt'){const r=rows[at(Number(q.get('ts')))];return json(r?{block:r.height,hash:r.hash,ts:r.ts,url:'https://mempool.space/block/'+r.hash}:{error:'before first final height'});}
  if(u.pathname==='/blocks'){return json(rows.filter(r=>r.height>=Number(q.get('from'))&&r.height<=Number(q.get('to'))));}
  const match=u.pathname.match(/^\/proof\/(\d+)$/);
  if(match){const row=rows[Number(match[1])-genesis];if(!row)return json({error:'height not finalized'},404);const s=step(row.header);return json({...row,block:row.height,R_h:s.R,S:row.U*1.2e-5,S_wad:(BigInt(row.U)*12000000000000n).toString(),price:price(row.U),confirmations:6,confirmedAt:row.ts,url:'https://mempool.space/block/'+row.hash,byteOrder:'R = SHA256(raw SHA256d(header)); explorer hash reverses raw digest'});}
  const p=path.resolve(staticDir,'.'+(u.pathname==='/'?'/index.html':u.pathname));
  if(p.startsWith(staticDir+path.sep)&&fs.existsSync(p)&&fs.statSync(p).isFile()){res.writeHead(200,{'content-type':p.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream'});return fs.createReadStream(p).pipe(res);}
  json({error:'not found'},404);
 }catch(e){json({error:e.message},500);}
}).listen(port,()=>console.log(`Bitcoin index :${port}, genesis ${genesis}`));
async function loop(fn,ms){for(;;){try{await fn();if(fn===sync&&!halted)error=null;}catch(e){error=e.message;console.error(e.message);}await new Promise(r=>setTimeout(r,ms));}}
loop(sync,15000);loop(pollChain,5000);
