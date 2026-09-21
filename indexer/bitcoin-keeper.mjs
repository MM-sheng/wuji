import { BitcoinAPI, step } from './bitcoin.mjs';
import { assertChain } from './networks.mjs';
import { rpcRequest } from './evm-rpc.mjs';
import { maintainFrozenExit } from './frozen-keeper.mjs';
// WUJI keeper — keeps WujiIndex ticking (≤ every 256 blocks) and settles fixed-block series.
// Signs with `cast` (Foundry) so this file has no dependencies and never touches the key itself.
//
//   RPC=... KEYSTORE_ACCOUNT=... PASSWORD_FILE=... CONTRACT=<WujiIndex> [FACTORY=<WujiVaultFactory>] [VAULT=<WujiVault>] [INTERVAL=45] node indexer/keeper.mjs
//   With FACTORY set, every vault the factory knows is settled; VAULT alone settles just that one.
//
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const { RPC, KEYSTORE_ACCOUNT, PASSWORD_FILE, CONTRACT, VAULT, FACTORY } = process.env;
const INTERVAL = +(process.env.INTERVAL || 45);
if (!RPC || !KEYSTORE_ACCOUNT || !PASSWORD_FILE || !CONTRACT) { console.error('need RPC, KEYSTORE_ACCOUNT, PASSWORD_FILE, CONTRACT (run contracts/scripts/set-key.sh)'); process.exit(1); }
const CAST = process.env.CAST || path.join(os.homedir(), '.foundry', 'bin', 'cast');
const RPC0 = RPC.split(',')[0];
const cast = (...a) => execFileSync(CAST, [...a, '--rpc-url', RPC0], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PWFILE = path.isAbsolute(PASSWORD_FILE) ? PASSWORD_FILE : path.join(process.cwd(), 'contracts', PASSWORD_FILE);
const gasOptions=process.env.KEEPER_GAS_PRICE?['--legacy','--gas-price',process.env.KEEPER_GAS_PRICE]:[];
const expectedChain=Number(process.env.CHAIN_ID||97);
const checkChain=()=>assertChain(cast('chain-id'),expectedChain);
const send = (to, sig, gas, ...args) => {
 checkChain();
 // Keep the per-operation ceiling, but do not reserve its full value for every small transaction.
 // Estimate with the actual worker and fee options, then allow 25% execution headroom.
 const estimate=BigInt(cast('estimate',to,sig,...args,'--from',workerAddress(),...gasOptions).split(/\s/)[0]);
 const ceiling=BigInt(gas);
 if(estimate<21000n)throw Error('invalid keeper gas estimate');
 if(estimate>ceiling)throw Error('keeper gas estimate exceeds operation ceiling');
 const padded=(estimate*125n+99n)/100n,limit=padded<ceiling?padded:ceiling;
 checkChain(); // The provider may have changed during estimation; check again before signing.
 return cast('send', to, sig, ...args, '--chain', String(expectedChain), '--account', KEYSTORE_ACCOUNT, '--password-file', PWFILE, '--gas-limit', limit.toString(), ...gasOptions, '--json');
};
let cachedWorker;
const workerAddress=()=>cachedWorker ||= execFileSync(CAST,['wallet','address','--account',KEYSTORE_ACCOUNT,'--password-file',PWFILE],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const redact = s => { const lines = String(s).replace(/0x[0-9a-fA-F]{64}/g, '0x…').split('\n').map(l => l.trim()).filter(Boolean); return lines.find(l => /^Error|insufficient|revert|nonce|underpriced|timeout/i.test(l)) || lines.find(l => !/^Command failed/.test(l)) || 'cast send failed'; };
const num = s => Number(BigInt(s.split(' ')[0]));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const reserveMode=process.env.REWARD_MODEL==='operations-reserve';
const timestampRules=process.env.RELAY_TIMESTAMPS==='1';
const REWARDS=process.env.REWARDS;
const rewardTokens=[...new Set((process.env.REWARD_TOKENS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean))].sort();
if(reserveMode&&(!REWARDS||rewardTokens.length>8||rewardTokens.some(t=>!/^0x[0-9a-f]{40}$/.test(t)||/^0x0{40}$/.test(t))))throw Error('reserve mode needs REWARDS and up to eight valid REWARD_TOKENS');
const claimInterval=Number(process.env.CLAIM_EVERY_HEIGHTS||144);
if(!Number.isSafeInteger(claimInterval)||claimInterval<1)throw Error('CLAIM_EVERY_HEIGHTS must be positive');
let lastClaimHeight=0;
const routeInterval=Number(process.env.ROUTE_EVERY_HEIGHTS||144);
if(!Number.isSafeInteger(routeInterval)||routeInterval<1)throw Error('ROUTE_EVERY_HEIGHTS must be positive');
let lastRouteHeight=0;
const succeeded=r=>r.status==='0x1'||r.status===1;
async function routeFees(assets){
 for(const asset of assets){
  try {
   if(process.env.FEE_ROUTER){
    const balance=BigInt(cast('call',asset,'balanceOf(address)(uint256)',process.env.FEE_ROUTER).split(' ')[0]);
    if(balance>=(reserveMode?1n:2n)){
     const r=JSON.parse(send(process.env.FEE_ROUTER,'route(address)',700_000,asset));
     if(!succeeded(r))throw Error('route reverted');log('route',asset,r.transactionHash);
    }
   }
   if(reserveMode){
    const balance=BigInt(cast('call',asset,'balanceOf(address)(uint256)',REWARDS).split(' ')[0]);
    const unused=BigInt(cast('call',REWARDS,'reserve(address)(uint256)',asset).split(' ')[0]);
    const allocated=BigInt(cast('call',REWARDS,'allocated(address)(uint256)',asset).split(' ')[0]);
    if(balance>unused+allocated){const r=JSON.parse(send(REWARDS,'sync(address)',200_000,asset));if(!succeeded(r))throw Error('sync reverted');log('sync donation',asset,r.transactionHash);}
   }
  }catch(e){log('fee route:',redact(e.stderr||e.message));}
 }
}
function claimBounties(last){
 if(!reserveMode||last-lastClaimHeight<claimInterval)return;
 lastClaimHeight=last; // Failed tokens are retried on a later interval, not on every poll.
 const worker=workerAddress();
 for(const token of rewardTokens){
  try{
   const amount=BigInt(cast('call',REWARDS,'claimable(address,address)(uint256)',token,worker).split(' ')[0]);
   if(amount===0n)continue;
   const r=JSON.parse(send(REWARDS,'claim(address)',300_000,token));if(!succeeded(r))throw Error('claim reverted');
   log('claim fixed bounty',token,amount.toString(),r.transactionHash);
  }catch(e){log('bounty claim:',redact(e.stderr||e.message));}
 }
}
const api=new BitcoinAPI();
const RELAY=process.env.RELAY;
if(!RELAY)throw Error('RELAY required');
const frozenExitMode=process.env.FROZEN_EXIT==='1';
if(frozenExitMode&&![97,11155111].includes(expectedChain))throw Error('Frozen-exit automation is testnet-only');
const handleExit=()=>maintainFrozenExit({rpc:(m,p)=>rpcRequest(RPC0,m,p),index:CONTRACT,relay:RELAY,chainId:expectedChain,
 vaults:()=>FACTORY?listVaults():VAULT?[VAULT]:[],send:async(to,sig,gas)=>{const r=JSON.parse(send(to,sig,gas));if(!succeeded(r))throw Error(sig+' reverted');log(sig,to,r.transactionHash);}});
async function once(){
 checkChain();
 let exitState=frozenExitMode?await handleExit():null;
 // Completed exits and claims do not depend on Bitcoin API availability.
 if(exitState?.frozen){claimBounties(num(cast('call',CONTRACT,'lastHeight()(uint64)')));return;}
 const tip=await api.tip();
 const best=num(cast('call',RELAY,'bestHeight()(uint64)'));
 const checkpoint=num(cast('call',RELAY,'checkpointHeight()(uint64)'));
 const checkpointHash=cast('call',RELAY,'checkpointHash()(bytes32)').toLowerCase();
 if('0x'+step((await api.at(checkpoint)).header).internalHash!==checkpointHash)throw Error('source disagrees with trusted relay checkpoint');
 let common=Math.min(best,tip);
 const source=await api.at(common);
 if('0x'+step(source.header).internalHash!==cast('call',RELAY,'headerAt(uint64)(bytes32)',String(common)).toLowerCase()){
  // A competing branch may need several batches before it outweighs the incumbent.
  // Search ALL known headers, not only headerAt(), or every retry would resend the first batch.
  let lo=checkpoint,hi=tip;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2),candidate=await api.at(mid);
   try{cast('call',RELAY,'heightOf(bytes32)(uint64)','0x'+step(candidate.header).internalHash);lo=mid;}
   catch(e){if(String(e.stderr||e.message).includes('unknown header'))hi=mid-1;else throw e;}
  }
  common=lo;
 }
 const end=Math.min(tip,common+24);
 let atomic=false;
 if(reserveMode){
  const folded=num(cast('call',CONTRACT,'lastHeight()(uint64)'));
  if(folded-lastRouteHeight>=routeInterval){lastRouteHeight=folded;await routeFees(rewardTokens);}
 }
 if(end>common){
  const headers=[];
  for(let h=common+1;h<=end;h++){const b=await api.at(h);if(step(b.header).hash!==b.hash)throw Error('Bitcoin source hash mismatch');headers.push(b.header);}
  let foldHealthy=!exitState||exitState.historyConsistent;
  if(reserveMode&&foldHealthy){
   try{cast('call',CONTRACT,'fold(uint256)(uint64)','0');}
   catch(e){if(/deep Bitcoin reorg|relay stale/.test(String(e.stderr||e.message)))foldHealthy=false;else throw e;}
  }
  atomic=reserveMode&&common===best&&foldHealthy;
  if(atomic&&timestampRules){
   // A batch from an empty old checkpoint may still end far in the past. Simulate before paying for
   // an atomic call that would roll all accepted headers back at the freshness gate.
   try{cast('call',CONTRACT,'submitAndFold(bytes,uint256,address[])(uint64)','0x'+headers.join(''),'16','['+rewardTokens.join(',')+']','--from',workerAddress());}
   catch(e){if(String(e.stderr||e.message).includes('relay stale'))atomic=false;else throw e;}
  }
  const r=JSON.parse(atomic
   ?send(CONTRACT,'submitAndFold(bytes,uint256,address[])',8_000_000,'0x'+headers.join(''),'16','['+rewardTokens.join(',')+']')
   :send(RELAY,'submit(bytes)',5_000_000,'0x'+headers.join('')));
  if(r.status!=='0x1'&&r.status!==1)throw Error('relay transaction reverted');
  log(`${atomic?'submit + fold':'submit'} Bitcoin ${common+1}..${end} ${r.transactionHash}`);
 }
 if(frozenExitMode){
  exitState=await handleExit();
  if(!exitState.historyConsistent||exitState.frozen){log('exit status',exitState.phase,'remaining heights',exitState.remaining);return;}
 }
 // Detect deep reorgs even if pending() is zero, before any settlement transactions.
 try{cast('call',CONTRACT,'fold(uint256)(uint64)','0');}
 catch(e){
  if(timestampRules&&String(e.stderr||e.message).includes('relay stale')){log('catching up: relay tip is stale; headers retained, fold deferred');return;}
  throw e;
 }
 const pending=num(cast('call',CONTRACT,'pending()(uint256)'));
 // Fund BEFORE new work: old allocations can never claim these new fees.
 if(pending&&!atomic){
  const count=Math.min(pending,16);
  const r=JSON.parse(reserveMode
   ?send(CONTRACT,'fold(uint256,address[])',6_000_000,String(count),'['+rewardTokens.join(',')+']')
   :send(CONTRACT,'fold(uint256)',6_000_000,String(count)));
  if(!succeeded(r))throw Error('fold reverted');log('fold',count,r.transactionHash);
 }
 // Legacy comparison manifests retain their original routing flow.
 if(!reserveMode&&process.env.FEE_ROUTER){
  const assets=new Set();
  for(const v of FACTORY?listVaults():VAULT?[VAULT]:[]) {
   try{assets.add(cast('call',v,'asset()(address)'));}catch(e){log('fee asset:',redact(e.message));}
  }
  await routeFees(assets);
 }
 const last=num(cast('call',CONTRACT,'lastHeight()(uint64)'));
 claimBounties(last);
 for(const v of FACTORY?listVaults():VAULT?[VAULT]:[]){
  const boundary=num(cast('call',v,'currentSettlementHeight()(uint64)'));
  if(last>=boundary){const r=JSON.parse(send(v,'settle()',3_500_000));if(r.status!=='0x1'&&r.status!==1)throw Error('settle reverted');log('settle',v,boundary,r.transactionHash);}
 }
}
let vaultCache = { at: 0, list: [] };
function listVaults() {                                    // re-read the factory every ~10 min: anyone can add a vault
  if (Date.now() - vaultCache.at < 600_000) return vaultCache.list;
  const n = num(cast('call', FACTORY, 'count()(uint256)'));
  const list = []; for (let i = 0; i < n; i++) list.push(cast('call', FACTORY, 'vaults(uint256)(address)', String(i)));
  vaultCache = { at: Date.now(), list }; log(`factory has ${n} vault(s)`); return list;
}
log(`keeper ${reserveMode?'operations reserve':'legacy'} on ${CONTRACT}${FACTORY ? ' + factory ' + FACTORY : VAULT ? ' + vault ' + VAULT : ''} every ${INTERVAL}s`);
for (;;) { try { await once(); } catch (e) { log('error:', redact([e.stderr, e.stdout, e.message].filter(Boolean).join('\n'))); } await new Promise(r => setTimeout(r, INTERVAL * 1000)); }
