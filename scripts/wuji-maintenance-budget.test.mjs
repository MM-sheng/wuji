import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {replayWeek} from './wuji-cost-week.mjs';import {maintenanceBudget} from './wuji-maintenance-budget.mjs';
const week=replayWeek('docs/reviews/evidence/operations-week-2026-10-23');
const balances=()=>({chainId:11155111,block:{number:'0x1'},worker:{address:week.summary.worker,code:'0x',nativeBalanceWei:'2688487400000000',wethWei:'999999999999999999999'},deployer:{code:'0x',nativeBalanceWei:'765467113191317708'},rewards:{reserveWei:'0',allocatedWei:'0',actualTokenBalanceWei:'0'}});
test('receipt-based planning yields a rounded fuel target and a conditional, not automatic, allocation',()=>{
 const r=maintenanceBudget(week,balances());assert.equal(r.basis.totalGas,'81564271');assert.equal(r.basis.peakDayGas,'15712271');
 assert.equal(r.scenarios[0].mean30DaysWei,'34956116142857143');assert.equal(r.scenarios[0].peak30DaysPlus25PercentWei,'58921016250000000');
 assert.equal(r.sepolia.proposedRoundedWorkerTargetWei,'60000000000000000');assert.equal(r.sepolia.workerTopUpGapWei,'57311512600000000');assert.equal(r.sepolia.combinedGapIfDeployerFundsAreAllocatedWei,'0');assert.equal(r.sepolia.allocationAuthorizedOrExecuted,false);
 assert.equal(r.funding.nativeGasCreditFromWethWei,'0');assert.equal(r.funding.mainnetCommittedFundingWei,null);
});
test('a funded worker has zero top-up gap; no deployer funds leaves the worker gap uncovered',()=>{
 const b=balances();b.worker.nativeBalanceWei='100000000000000000';assert.equal(maintenanceBudget(week,b).sepolia.workerTopUpGapWei,'0');
 b.worker.nativeBalanceWei='0';b.deployer.nativeBalanceWei='0';assert.equal(maintenanceBudget(week,b).sepolia.combinedGapIfDeployerFundsAreAllocatedWei,'60005000000000000');
});
test('higher gas prices and doubled execution units increase planning costs without consuming testnet balances',()=>{
 const r=maintenanceBudget(week,balances());assert.equal(BigInt(r.scenarios[1].peak30DaysPlus25PercentWei),10n*BigInt(r.scenarios[0].peak30DaysPlus25PercentWei));
 for(const s of r.scenarios)assert.equal(BigInt(s.doubleExecutionLoadPlus25PercentWei),2n*BigInt(s.peak30DaysPlus25PercentWei));
 const broken=structuredClone(week);broken.windows[0].transactions[0].blobFeeWei='1';assert.throws(()=>maintenanceBudget(broken,balances()),/blob fees/);
});
