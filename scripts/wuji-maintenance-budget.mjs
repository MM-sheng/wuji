// Offline planning arithmetic. Does not allocate funds or change runtime configuration.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {replayWeek} from './wuji-cost-week.mjs';
const ceil=(a,b)=>(a+b-1n)/b,max=(a,b)=>a>b?a:b;
export function maintenanceBudget(week,balances){
 const {windows,summary}=week;assert.equal(summary.status,'COMPLETE');assert.equal(windows.length,7);
 assert.equal(balances.chainId,11155111);assert.equal(balances.worker.address.toLowerCase(),summary.worker.toLowerCase());
 assert.equal(balances.worker.code,'0x');assert.equal(balances.deployer.code,'0x');
 const gas=windows.map(w=>w.transactions.reduce((s,t)=>{assert.equal(BigInt(t.blobFeeWei),0n,'blob fees need a separate price scenario');return s+BigInt(t.gasUsed);},0n));
 const totalGas=gas.reduce((a,b)=>a+b,0n),peakGas=gas.reduce(max,0n);
 assert.ok(totalGas>0n);const prices=[...new Set(windows.flatMap(w=>w.transactions.map(t=>t.effectiveGasPriceWei)))];
 const worker=BigInt(balances.worker.nativeBalanceWei),deployer=BigInt(balances.deployer.nativeBalanceWei);assert.ok(worker>=0n&&deployer>=0n);
 const scenarios=[100000000n,1000000000n,5000000000n,10000000000n].map(price=>{
  const mean30=ceil(totalGas*30n*price,7n),peak30=peakGas*30n*price,target=ceil(peak30*125n,100n);
  return {effectiveGasPriceWei:String(price),mean30DaysWei:String(mean30),peak30DaysWei:String(peak30),peak30DaysPlus25PercentWei:String(target),doubleExecutionLoadPlus25PercentWei:String(2n*target)};
 });
 const base=scenarios[0];assert.deepEqual(prices,['100000000'],'baseline requires the observed 0.1 gwei sample');
 const unit=10n**16n,target=ceil(BigInt(base.peak30DaysPlus25PercentWei),unit)*unit;
 const gap=max(0n,target-worker),topUpFeeAllowance=gap>0n?50000n*100000000n:0n;
 return {schemaVersion:1,status:'PLANNING_ESTIMATE',basis:{startTimestamp:summary.startTimestamp,endTimestamp:summary.endTimestamp,windowCount:7,transactions:summary.transactions,totalGas:String(totalGas),peakDayGas:String(peakGas),observedEffectiveGasPricesWei:prices,weeklyGasFeeWei:summary.gasFeeWei},assumptions:{days:30,contingencyPercent:25,conservativeLoad:'Repeat highest observed daily gas for all 30 days; this is not a statistical upper bound.',priceScenarios:'Hypothetical constant effective prices, not current mainnet quotes. Same execution units, no deployment, catch-up, seal incident, host, RPC or audit costs.',doubleLoad:'Exactly twice execution units, illustrative; not a tested second-keeper architecture.'},scenarios,sepolia:{chainId:11155111,balanceBlock:balances.block,workerBalanceWei:String(worker),deployerBalanceWei:String(deployer),combinedObservedBalanceWei:String(worker+deployer),proposedRoundedWorkerTargetWei:String(target),workerTopUpGapWei:String(gap),combinedGapIfDeployerFundsAreAllocatedWei:String(max(0n,gap+topUpFeeAllowance-deployer)),topUpFeeAllowanceWei:String(topUpFeeAllowance),topUpFeeAssumption:'50000 gas at 0.1 gwei as a planning allowance, not an estimate or signed transaction',deployerOutflowIfAllocatedWei:String(gap+topUpFeeAllowance),proposedDeployerAllocationWei:String(gap),allocationAuthorizedOrExecuted:false,illustrativeMeanRunwayDays:Number(worker*7n*10000n/BigInt(summary.gasFeeWei))/10000,runwayIsGuarantee:false},funding:{weeklyWethAllocatedWei:summary.rewardsAllocatedWei,weeklyWethClaimedWei:summary.rewardsClaimedWei,reserveWethWei:balances.rewards.reserveWei,allocatedWethWei:balances.rewards.allocatedWei,actualReserveWethWei:balances.rewards.actualTokenBalanceWei,workerWethWei:balances.worker.wethWei,workerClaimableWethWei:balances.worker.claimableWethWei,feeRouterWethWei:balances.feeRouter?.wethWei,nativeGasCreditFromWethWei:'0',conversionOrFundingAssumed:false,knownProtocolNativeGasIncomeWei:'0',mainnetCommittedFundingWei:null,mainnetGap:'Not established; Sepolia ETH does not fund mainnet. With no committed mainnet funds, the full selected ETH scenario remains unfinanced.',unknownCosts:['hosting/electricity','paid or archival RPC','second independent operator','deployment/catch-up/reorg or seal incidents','external audit and incident handling']}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{assert.equal(process.argv.length,4,'usage: node scripts/wuji-maintenance-budget.mjs WEEK_DIR BALANCES_JSON');console.log(JSON.stringify(maintenanceBudget(replayWeek(process.argv[2]),JSON.parse(fs.readFileSync(process.argv[3]))),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
