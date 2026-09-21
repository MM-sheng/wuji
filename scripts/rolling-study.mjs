// Offline application research only. No quotes, transactions, network access or production dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const WAD = 10n ** 18n;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const json = name => JSON.parse(read(name));
const sha = bytes => createHash('sha256').update(bytes).digest();
const ceilDiv = (a, b) => (a + b - 1n) / b;
function constant(file, name) {
  const literal = read(file).match(new RegExp('\\bconstant\\s+' + name + '\\s*=\\s*([^;]+);'))?.[1].replaceAll('_', '').trim();
  assert.match(literal ?? '', /^\d+(?:\.\d+)?(?:e\d+)?$/i, 'unsupported or missing constant ' + name);
  const [n, exponent = '0'] = literal.toLowerCase().split('e'), [whole, fraction = ''] = n.split('.');
  const numerator = BigInt(whole + fraction) * 10n ** BigInt(exponent), denominator = 10n ** BigInt(fraction.length);
  assert.equal(numerator % denominator, 0n, 'constant must be an exact integer');
  return numerator / denominator;
}

export function yangShare(deltaWad) {
  const share = WAD / 2n + deltaWad / 2n; // BigInt division truncates toward zero, as Solidity does.
  return share < 0n ? 0n : share > WAD ? WAD : share;
}

// price is collateral base units per one whole claim; fees below are explicit execution assumptions.
export function enter({cash, notional, price, allocationWad = WAD, entryBps = 0n, fixedCost = 0n}) {
  assert.ok(cash >= 0n && notional > 0n && fixedCost >= 0n && entryBps >= 0n);
  assert.ok(allocationWad >= 0n && allocationWad <= WAD);
  const skipped = reason => ({status: reason, notional, quantityWad: 0n, idleCash: cash,
    spent: 0n, entryCharge: 0n, fixedCost: 0n});
  if (price === null) return skipped('no-quote');
  assert.ok(price > 0n, 'zero/negative quote is not an executable acquisition');
  if (cash <= fixedCost || allocationWad === 0n) return skipped('no-budget');
  const budget = (cash - fixedCost) * allocationWad / WAD;
  const cost = q => {
    const gross = ceilDiv(q * price, WAD);
    return {gross, charge: ceilDiv(gross * entryBps, 10000n)};
  };
  let low = 0n, high = budget * WAD / price;
  while (low < high) {
    const mid = (low + high + 1n) / 2n, c = cost(mid);
    if (c.gross + c.charge <= budget) low = mid; else high = mid - 1n;
  }
  if (low === 0n) return skipped('dust');
  const {gross, charge} = cost(low), spent = gross + charge;
  return {status: 'open', notional, quantityWad: low, idleCash: cash - fixedCost - spent,
    spent, entryCharge: charge, fixedCost};
}

// One-sided WujiVault redemption: floor quantity*notional*share, then floor fee on the gross amount.
export function redeem(position, share, feeBps = 0n) {
  assert.ok(share >= 0n && share <= WAD && feeBps >= 0n && feeBps <= 10000n);
  const gross = position.quantityWad * position.notional * share / (WAD * WAD);
  const fee = gross * feeBps / 10000n;
  return {gross, fee, cash: position.idleCash + gross - fee};
}

export function fixture() {
  const meta = json('contracts/test/fixtures/bitcoin-timestamps.json');
  const raw = Buffer.from(read('contracts/test/fixtures/bitcoin-timestamps.hex').trim().slice(2), 'hex');
  const refs = Buffer.from(read('contracts/test/fixtures/bitcoin-timestamps-vectors.hex').trim().slice(2), 'hex');
  const unit = constant('contracts/src/WujiIndex.sol', 'UNIT');
  const mean = constant('contracts/src/WujiIndex.sol', 'MEAN');
  assert.equal(raw.length, meta.count * 80); assert.equal(refs.length, meta.count * 32);
  let previous = sha(sha(Buffer.from(meta.checkpointHeader, 'hex'))), U = 0n;
  const steps = [];
  for (let i = 0; i < meta.count; i++) {
    const header = raw.subarray(i * 80, (i + 1) * 80);
    assert.deepEqual(header.subarray(4, 36), previous, 'broken parent at ' + (meta.start + i));
    const H = sha(sha(header)), R = sha(H);
    assert.deepEqual(R, refs.subarray(i * 32, (i + 1) * 32), 'fixture vector mismatch');
    const delta = BigInt([...R].reduce((a, b) => a + b, 0)) - mean;
    U += delta;
    steps.push({height: meta.start + i, deltaWad: delta * unit, S: U * unit, timestamp: header.readUInt32LE(68)});
    previous = H;
  }
  assert.equal(U.toString(), String(meta.U)); assert.equal((U * unit).toString(), meta.S_wad);
  return {meta, steps, rawSha256: sha(raw).toString('hex'), unit};
}

export function replay({steps, genesis, confirmations, interval, notional, initialCash, side,
  allocationWad, entryBps, redeemBps, fixedCost, price}) {
  assert.ok(Number.isInteger(interval) && interval > 0 && steps.length > confirmations);
  assert.ok(Number.isInteger(confirmations) && confirmations >= 0);
  assert.ok(side === 'YANG' || side === 'YIN');
  assert.ok(initialCash > 0n);
  const available = steps.length - confirmations, closed = Math.floor(available / interval);
  let cash = initialCash, peak = initialCash, maxDrawdown = 0, entryCharges = 0n, redemptionFees = 0n, fixedCosts = 0n;
  let firstZeroEquityHeight = null;
  const records = [];
  const buy = () => {
    const p = enter({cash, notional, price, allocationWad, entryBps, fixedCost});
    entryCharges += p.entryCharge; fixedCosts += p.fixedCost;
    return p;
  };
  for (let k = 0; k < closed; k++) {
    const start = k * interval, end = start + interval, before = cash, position = buy();
    const delta = steps.slice(start, end).reduce((s, x) => s + x.deltaWad, 0n);
    const y = yangShare(delta), a = side === 'YANG' ? y : WAD - y;
    const settled = redeem(position, a, redeemBps);
    cash = settled.cash; redemptionFees += settled.fee;
    if (cash > peak) peak = cash;
    const dd = peak === 0n ? 0 : Number(peak - cash) / Number(peak);
    maxDrawdown = Math.max(maxDrawdown, dd);
    if (cash === 0n && firstZeroEquityHeight === null) firstZeroEquityHeight = genesis + end - 1;
    records.push({series: k, startHeight: genesis + start, boundary: genesis + end - 1,
      earliestRelayHeight: genesis + end - 1 + confirmations, deltaSWad: delta, yangShareWad: y,
      publicNextIncrementWad: steps.slice(end, end + confirmations).reduce((s, x) => s + x.deltaWad, 0n),
      startingCash: before, position, grossPayout: settled.gross, redemptionFee: settled.fee, settledCash: cash});
  }
  const tailStart = closed * interval, lastClosedCash = cash;
  // Re-enter after the final observed settlement too: never silently discard the censored position.
  const tail = buy();
  const observedDelta = steps.slice(tailStart, available).reduce((s, x) => s + x.deltaWad, 0n);
  return {interval, side, allocationWad, entryBps, redeemBps, fixedCost, initialCash, completedPeriods: closed,
    lastCompletedBoundary: closed ? genesis + tailStart - 1 : null, lastClosedCash,
    lastClosedCashRatio: Number(lastClosedCash) / Number(initialCash), maxDrawdownAtSettlements: maxDrawdown,
    firstZeroEquityHeight, entryCharges, redemptionFees, fixedCosts, records,
    incomplete: {startHeight: genesis + tailStart, boundary: genesis + tailStart + interval - 1,
      observedFinalizedHeights: available - tailStart, remainingHeights: interval - (available - tailStart),
      position: tail, observedDeltaSWad: observedDelta, observedYangShareWad: yangShare(observedDelta),
      liquidationNAV: tail.quantityWad === 0n ? tail.idleCash : null,
      unrealizedPnL: tail.quantityWad === 0n ? 0n : null,
      reason: tail.quantityWad === 0n ? 'cash-only; no claim held' : 'no executable quote or expiry inside fixture'}};
}

export function buildStudy() {
  const planName = 'docs/tasks/T7_SIMULATION_PLAN.json', plan = json(planName);
  assert.equal(plan.fixture, 'contracts/test/fixtures/bitcoin-timestamps.hex');
  const f = fixture(), manifest = json('contracts/deployments/sepolia-weth-v3.json');
  const confirmations = Number(constant('contracts/src/WujiIndex.sol', 'CONFIRMATIONS'));
  const fee = constant('contracts/src/WujiVault.sol', 'FEE_BPS');
  assert.equal(plan.genesisHeight, f.meta.start); assert.equal(plan.intervals[0], manifest.checkpointInterval);
  assert.equal(manifest.unitWad, f.unit.toString()); assert.equal(manifest.confirmations, confirmations);
  const N = BigInt(manifest.vaults.WETH.notional), runs = [];
  for (const interval of plan.intervals) for (const side of plan.sides)
    for (const allocation of plan.allocationsWad) for (const cost of plan.costs) {
      runs.push({costModel: cost.id, ...replay({steps: f.steps, genesis: plan.genesisHeight, confirmations,
        interval, notional: N, initialCash: BigInt(plan.initialCashWei), side, allocationWad: BigInt(allocation),
        entryBps: BigInt(cost.entryBps), redeemBps: cost.protocolRedeemFee ? fee : 0n,
        fixedCost: BigInt(cost.fixedCostWei), price: N / 2n})});
    }
  return {schema: 1, purpose: plan.purpose, planSha256: sha(read(planName)).toString('hex'),
    input: {fixture: plan.fixture, rawHeadersSha256: f.rawSha256, count: f.steps.length,
      firstHeight: f.meta.start, lastHeight: f.meta.start + f.steps.length - 1,
      lastFinalizedHeight: f.meta.start + f.steps.length - confirmations - 1, confirmations,
      deployedInterval: manifest.checkpointInterval, notionalWei: N, feeBps: fee,
      firstHeaderTimestamp: f.steps[0].timestamp, lastHeaderTimestamp: f.steps.at(-1).timestamp,
      source: 'existing committed historical fixtures; no live quotes or new sample'},
    assumptions: plan, trialCount: runs.length, runs};
}

export const stringify = value => JSON.stringify(value, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2) + '\n';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(stringify(buildStudy()).trimEnd());
}
