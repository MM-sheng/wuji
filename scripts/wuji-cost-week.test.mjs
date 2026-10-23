import test from 'node:test';import assert from 'node:assert/strict';
import {planWeek,summarizeWeek,renderWeek} from './wuji-cost-week.mjs';
function fixture(){
 const plan=planWeek('2026-10-23T00:00:00+07:00');
 const windows=plan.windows.map((w,i)=>{
  const tx={hash:'tx'+i,nonce:i,timestamp:w.startTimestamp,blockNumber:'0x'+(i+1).toString(16),blockHash:'block'+(i+1),status:'0x1',category:'index',gasFeeWei:'42',valueWei:'0',executedValueWei:'0'};
  tx.receipt={transactionHash:tx.hash,blockNumber:tx.blockNumber,blockHash:tx.blockHash,status:tx.status,gasUsed:'0x15',effectiveGasPrice:'0x2'};
  return {status:'COMPLETE',chainId:11155111,worker:'worker',rewardToken:'WETH',requestedSeconds:86400,cutoffTimestamp:w.startTimestamp,windowEndExclusiveTimestamp:w.endTimestamp,endTimestamp:w.endTimestamp-12,startBlock:'0x'+i.toString(16),startBlockHash:'block'+i,endBlock:'0x'+(i+1).toString(16),endBlockHash:'block'+(i+1),firstNonce:i,lastNonce:i+1,coveredNonceCount:1,transactions:[tx],byCategory:{index:{transactions:1,failed:0,gasFeeWei:'42'}},gasFeeWei:'42',outgoingValueWei:'0',nativeBalanceBeforeWei:String(1000-i*42),nativeBalanceAfterWei:String(1000-(i+1)*42),nativeCreditsInferredWei:'0',rewardEvents:[],rewardsAllocatedWei:'0',rewardsClaimedWei:'0',indexProgress:{before:i,after:i+1,foldedHeights:1}};
 });return {plan,windows};
}
test('seven fixed Jakarta days are contiguous and summary uses integer receipts, not rolling totals',()=>{
 const {plan,windows}=fixture(),s=summarizeWeek(plan,windows);
 assert.equal(plan.endTimestamp-plan.startTimestamp,7*86400);assert.equal(s.gasFeeWei,'294');assert.equal(s.transactions,7);assert.equal(s.foldedHeights,7);
 assert.match(renderWeek(plan,windows,s),/2026-10-16 00:00/);assert.match(renderWeek(plan,windows,s),/UNKNOWN/);
});
test('overlap, missing day, duplicate transaction, wrong nonce, receipt fee and balance inconsistencies fail closed',()=>{
 for(const mutate of [
  f=>{f.plan.windows[1].startTimestamp--;},f=>{f.windows.pop();},f=>{f.windows[1].transactions[0].hash='tx0';},
  f=>{f.windows[1].transactions[0].nonce=99;},f=>{f.windows[1].gasFeeWei='0';},
  f=>{f.windows[1].transactions[0].receipt.gasUsed='0x1';},f=>{f.windows[1].nativeBalanceBeforeWei='0';},
  f=>{f.windows[1].startBlockHash='fork';},f=>{f.windows[1].status='INCOMPLETE';},
  f=>{f.windows[1].transactions[0].timestamp=f.plan.windows[1].endTimestamp;},
 ]){const f=fixture();mutate(f);assert.throws(()=>summarizeWeek(f.plan,f.windows));}
});
test('invalid plan timestamp and incomplete measurements cannot yield a weekly total',()=>{
 assert.throws(()=>planWeek('not-a-date'));const f=fixture();delete f.windows[0].indexProgress;assert.throws(()=>summarizeWeek(f.plan,f.windows));
});

test('completed windows resume with canonical hash checks and no new cost scan or archive overwrite',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {collectWeek,replayWeek}=await import('./wuji-cost-week.mjs');const {plan,windows}=fixture();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-week-'));
 try{
  const manifest={chainId:11155111,rpc:'https://rpc.invalid',WujiHeaderIndex:'index',RelayerRewards:'rewards',accounts:{collateral:{address:'WETH'},pools:[]}};
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify({...plan,worker:'worker',index:'index',rewards:'rewards',token:'WETH'}));
  windows.forEach((w,i)=>fs.writeFileSync(path.join(dir,`window-0${i+1}.json`),JSON.stringify(w)));
  const before=fs.readFileSync(path.join(dir,'window-01.json'),'utf8');let calls=0;
  const rpc=async(m,p)=>{assert.equal(m,'eth_getBlockByNumber');calls++;return {hash:'block'+Number(BigInt(p[0]))};};
  const s=await collectWeek({manifest:path.join(dir,'manifest.json'),worker:'worker'},dir,'2026-10-23T00:00:00+07:00',{rpc});
  assert.equal(calls,14);assert.equal(s.gasFeeWei,'294');assert.equal(replayWeek(dir).summary.gasFeeWei,'294');assert.equal(fs.readFileSync(path.join(dir,'window-01.json'),'utf8'),before);
  await assert.rejects(collectWeek({manifest:path.join(dir,'manifest.json'),worker:'worker'},dir,'2026-10-23T00:00:00+07:00',{rpc:async()=>({hash:'fork'})}),/reorganized/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
