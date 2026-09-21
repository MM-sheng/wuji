import test from 'node:test';
import assert from 'node:assert/strict';
import {WAD, enter, redeem, yangShare, replay, buildStudy, stringify} from './rolling-study.mjs';

test('0.8N buys 1.6 new claims at N/2, or 4/3 at 0.6N: quantities follow actual cost', () => {
  const first = enter({cash: 50n, notional: 100n, price: 50n});
  const proceeds = redeem(first, 8n * WAD / 10n).cash;
  assert.equal(proceeds, 80n);
  const next = enter({cash: proceeds, notional: 100n, price: 50n});
  assert.equal(next.quantityWad, 16n * WAD / 10n);
  const otherQuote = enter({cash: proceeds, notional: 100n, price: 60n});
  assert.equal(otherQuote.quantityWad, 80n * WAD / 60n);
  assert.equal(otherQuote.idleCash + otherQuote.spent, proceeds);
});

const scenario = (deltas, overrides = {}) => replay({steps: deltas.map(deltaWad => ({deltaWad})),
  genesis: 100, confirmations: 1, interval: 1, notional: 100n, initialCash: 100n,
  side: 'YANG', allocationWad: WAD, entryBps: 0n, redeemBps: 0n, fixedCost: 0n, price: 50n, ...overrides});

test('equal positive and negative moves leave 64%, despite value-correct reinvestment', () => {
  const r = scenario([6n * WAD / 10n, -6n * WAD / 10n, 0n]);
  assert.deepEqual(r.records.map(x => x.settledCash), [160n, 64n]);
  assert.equal(r.records[1].position.quantityWad, 32n * WAD / 10n);
  assert.equal(r.maxDrawdownAtSettlements, 0.6);
});

test('a zero payout is absorbing for full allocation, and is not silently dropped', () => {
  const r = scenario([-WAD, WAD, 0n]);
  assert.equal(r.lastClosedCash, 0n);
  assert.equal(r.firstZeroEquityHeight, 100);
  assert.equal(r.records[1].position.status, 'no-budget');
  assert.equal(r.incomplete.liquidationNAV, 0n);
});

test('quarter allocation retains 75% after a complete directional loss, before costs', () => {
  const r = scenario([-WAD, 0n], {allocationWad: WAD / 4n});
  assert.equal(r.lastClosedCash, 75n);
  assert.equal(r.records[0].position.idleCash, 75n);
});

test('no quote or unaffordable fixed costs preserve cash; nonpositive quotes are rejected', () => {
  for (const args of [{price: null}, {price: 50n, fixedCost: 101n}]) {
    const p = enter({cash: 100n, notional: 100n, ...args});
    assert.equal(p.quantityWad, 0n); assert.equal(p.idleCash, 100n); assert.equal(p.fixedCost, 0n);
  }
  assert.throws(() => enter({cash: 100n, notional: 100n, price: 0n}), /quote/);
});

test('integer cost ledger cannot spend beyond budget; fee is floored after gross redemption', () => {
  // Entry: 9999 gross + ceil(9.999) surcharge + 3 fixed = 10012.
  const p = enter({cash: 10012n, notional: 20000n, price: 10000n, entryBps: 10n, fixedCost: 3n});
  assert.equal(p.quantityWad, 9999n * WAD / 10000n);
  assert.equal(p.entryCharge, 10n); assert.equal(p.idleCash, 0n);
  const out = redeem(p, WAD / 2n, 5n);
  assert.equal(out.gross, 9999n); assert.equal(out.fee, 4n); assert.equal(out.cash, 9995n);
  assert.equal(out.cash + out.fee + p.entryCharge + p.fixedCost, 10012n);
});

test('paired claims conserve gross collateral independently of a chosen allocation path', () => {
  const p = enter({cash: 500000n, notional: 1000000n, price: 500000n});
  for (const delta of [-2n * WAD, -WAD, -WAD / 5n, 0n, WAD / 5n, WAD, 2n * WAD]) {
    const y = yangShare(delta), a = redeem(p, y), b = redeem(p, WAD - y);
    assert.equal(a.gross + b.gross, 1000000n);
    assert.equal(redeem(p, y, 5n).cash + redeem(p, WAD - y, 5n).cash, 999500n);
  }
});

test('budget search agrees with an independent integer inverse across tiny budgets and fee rounding', () => {
  for (const cash of [1n, 2n, 17n, 9999n, 10001n]) for (const price of [1n, 7n, 10000n])
    for (const bps of [0n, 5n, 999n]) {
      // ceil(gross * (10000 + bps) / 10000) <= cash has this exact integer inverse.
      const maxGross = cash * 10000n / (10000n + bps);
      const p = enter({cash, notional: 20000n, price, entryBps: bps});
      assert.equal(p.quantityWad, maxGross * WAD / price);
      assert.equal(p.spent + p.idleCash, cash);
    }
});

test('unfinished position remains unpriced; final successor heads cannot settle an incomplete series', () => {
  const r = scenario([WAD / 10n, WAD / 10n, -WAD / 10n, WAD], {interval: 2});
  assert.equal(r.completedPeriods, 1);
  assert.equal(r.lastClosedCash, 120n);
  assert.equal(r.incomplete.observedFinalizedHeights, 1);
  assert.equal(r.incomplete.observedDeltaSWad, -WAD / 10n);
  assert.equal(r.incomplete.liquidationNAV, null);
  assert.equal(r.incomplete.unrealizedPnL, null);
  assert.ok(r.incomplete.position.quantityWad > 0n);
  assert.equal(r.records[0].publicNextIncrementWad, -WAD / 10n);
});

test('replay exports all prespecified trials and only one full deployed-length historical series', () => {
  const r = buildStudy();
  assert.equal(r.trialCount, 36);
  assert.equal(r.input.count, 6060); assert.equal(r.input.lastFinalizedHeight, 804389);
  for (const trial of r.runs.filter(x => x.interval === 4320)) {
    assert.equal(trial.completedPeriods, 1);
    assert.equal(trial.incomplete.observedFinalizedHeights, 1734);
    assert.equal(trial.incomplete.liquidationNAV, null);
  }
  assert.equal(JSON.parse(stringify(r)).runs[0].initialCash, '1000000000000000000');
});
