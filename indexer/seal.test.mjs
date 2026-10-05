import test from 'node:test'; import assert from 'node:assert/strict';
import { sha256d } from './bitcoin.mjs';
import { headerWork, planSeal } from './seal.mjs';

// Regtest difficulty: about every second nonce qualifies, and each header carries work 2.
const BITS = 0x207fffff;
const TARGET = 0x7fffffn << 232n;
const w = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
function mine(prev, time, salt) {
  const h = Buffer.alloc(80);
  h.writeInt32LE(4, 0); Buffer.from(prev, 'hex').copy(h, 4); h.writeUInt32LE(salt >>> 0, 36);
  h.writeUInt32LE(time, 68); h.writeUInt32LE(BITS, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt('0x' + Buffer.from(sha256d(h)).reverse().toString('hex')) <= TARGET) return h;
  }
}
const hashOf = h => sha256d(h).toString('hex');
/// heights → headers: a shared prefix 0..fork, then `salt` decides the branch.
function chain(from, to, salt, prefix = new Map()) {
  const out = new Map(prefix);
  for (let h = from; h <= to; h++) out.set(h, mine(h === 0 ? '00'.repeat(32) : hashOf(out.get(h - 1)), 1_700_000_000 + 600 * h, salt * 1e6 + h));
  return out;
}
const source = c => ({ tip: async () => Math.max(...c.keys()), at: async h => ({ header: c.get(h).toString('hex') }) });
/// A continuity() return as the contract encodes it; planSeal reads the hash (word 0) and the work (word 17).
const state = (c, height, work) => '0x' + hashOf(c.get(height)) + w(height) + w(BITS) + w(0) + w(0) + w(0)
  + Array.from({ length: 11 }, () => w(0)).join('') + w(work);

const main = chain(0, 400, 1);
// Anchor at 100 (work 0); folds recorded at 200 and 300; the finalized tip is 300 with work 2 · 200.
const tip = { height: 300, hash: '0x' + hashOf(main.get(300)), bits: BITS, work: '0x' + w(400) };
const states = { 100: state(main, 100, 0), 200: state(main, 200, 200), 300: state(main, 300, 400) };
const opts = { tip, states, confirmations: 100, margin: 144, maxHeaders: 800 };

test('regtest headers carry work 2', () => assert.equal(headerWork(BITS), 2n));

test('no reorg while the source still has the finalized tip', async () => {
  assert.deepEqual(await planSeal({ ...opts, source: source(main) }), { action: 'none' });
});

test('a source still syncing below the tip is not a reorg', async () => {
  assert.deepEqual(await planSeal({ ...opts, source: source(chain(0, 250, 1)) }), { action: 'none' });
});

test('a reorg below the threshold waits and says how far it is', async () => {
  // Fork after 250: the highest saved state still on the new chain is 200 (work 200). Need 400 + 244 · 2 = 888;
  // up to 500 the branch has 200 + 300 · 2 = 800, 44 blocks short.
  const branch = chain(251, 500, 2, new Map([...main].filter(([h]) => h <= 250)));
  const plan = await planSeal({ ...opts, source: source(branch) });
  assert.equal(plan.action, 'wait'); assert.equal(plan.forkBase, 200); assert.equal(plan.short, 44);
});

test('a reorg past the threshold seals from the highest saved state with the shortest branch', async () => {
  const branch = chain(251, 600, 2, new Map([...main].filter(([h]) => h <= 250)));
  const plan = await planSeal({ ...opts, source: source(branch) });
  assert.equal(plan.action, 'seal'); assert.equal(plan.forkBase, 200); assert.equal(plan.base, states[200]);
  assert.equal(plan.branchHeight, 544, '200 + (888 − 200) / 2');
  assert.equal((plan.headers.length - 2) / 160, 344);
  assert.equal(plan.headers.slice(2, 162), branch.get(201).toString('hex'), 'starts right after the base');
});

test('a reorg below every saved state cannot be sealed by this keeper', async () => {
  const branch = chain(51, 700, 3, new Map([...main].filter(([h]) => h <= 50)));
  const plan = await planSeal({ ...opts, source: source(branch) });
  assert.equal(plan.action, 'wait'); assert.match(plan.reason, /no saved state/);
});

test('a branch longer than the contract accepts asks for an older state', async () => {
  const branch = chain(251, 600, 2, new Map([...main].filter(([h]) => h <= 250)));
  const plan = await planSeal({ ...opts, maxHeaders: 300, source: source(branch) });
  assert.equal(plan.action, 'wait'); assert.match(plan.reason, /more than 300 headers/);
});
