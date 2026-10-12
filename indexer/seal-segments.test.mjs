import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256d } from './bitcoin.mjs';
import { saveState, loadStates } from './seal.mjs';
import { decodeReorgProof, planSegmentedSeal, proofFromReceipt, submitReorgStep, REORG_PROGRESS_TOPIC } from './seal-segments.mjs';

const BITS = 0x207fffff, TARGET = 0x7fffffn << 232n;
const w = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const hash = h => sha256d(h).toString('hex');
function chain(from, to, salt, prefix = new Map()) {
  const c = new Map(prefix);
  for (let height = from; height <= to; height++) {
    const h = Buffer.alloc(80);
    h.writeInt32LE(4); if (height) Buffer.from(hash(c.get(height - 1)), 'hex').copy(h, 4);
    h.writeUInt32LE(salt + height, 36); h.writeUInt32LE(1_700_000_000 + height * 600, 68); h.writeUInt32LE(BITS, 72);
    for (let n = 0; ; n++) {
      h.writeUInt32LE(n, 76);
      if (BigInt('0x' + Buffer.from(sha256d(h)).reverse().toString('hex')) <= TARGET) break;
    }
    c.set(height, h);
  }
  return c;
}
const main = chain(0, 1000, 1_000_000);
const fork = chain(101, 1050, 2_000_000, new Map([...main].filter(([h]) => h <= 100)));
const source = c => ({ tip: async () => Math.max(...c.keys()), at: async h => ({ header: c.get(h).toString('hex') }) });
const state = (c, h) => '0x' + hash(c.get(h)) + w(h) + w(BITS) + w(1_700_000_000 + h * 600) + w(0) + w(0)
  + Array.from({ length: 11 }, (_, i) => w(1_700_000_000 + (h - 10 + i) * 600)).join('') + w((h - 100) * 2);
const tipAt = h => ({ height: h, hash: '0x' + hash(main.get(h)), bits: BITS, work: (h - 100) * 2 });
const tip = tipAt(657);
const states = { 100: state(main, 100), 350: state(main, 350), 600: state(main, 600), 657: state(main, 657) };
const opts = { tip, states, source: source(fork), confirmations: 100, margin: 144, maxHeaders: 256 };
const proofAt = (c, h, target = tip, base = 100) => '0x' + w(base) + w(target.height) + target.hash.slice(2) + state(c, h).slice(2);
const index = '0x' + '11'.repeat(20);
const receipt = proof => ({ status: '0x1', logs: [{ address: index,
  topics: [REORG_PROGRESS_TOPIC, '0x' + 'ab'.repeat(32)], data: '0x' + w(32) + w(672) + proof.slice(2) }] });

test('801-header reorg is planned as bounded segments, persists across rounds, then seals', async () => {
  let proof, plan;
  const sizes = [];
  for (let i = 0; i < 4; i++) {
    plan = await planSegmentedSeal({ ...opts, proof });
    assert.equal(plan.action, i ? 'extend' : 'begin');
    sizes.push((plan.headers.length - 2) / 160);
    assert.equal(plan.forkBase, 100);
    proof = proofAt(fork, plan.branchHeight);
  }
  assert.deepEqual(sizes, [256, 256, 256, 33]);
  assert.equal(decodeReorgProof(proof).branch.height, 901);
  plan = await planSegmentedSeal({ ...opts, proof });
  assert.equal(plan.action, 'finish');
});

test('normal finalized progress raises the threshold for an existing proof', async () => {
  const proof = proofAt(fork, 901);
  const plan = await planSegmentedSeal({ ...opts, tip: tipAt(667), proof });
  assert.equal(plan.action, 'extend');
  assert.equal(plan.branchHeight, 911);
  assert.equal((plan.headers.length - 2) / 160, 10);
});

test('changed Bitcoin branch restarts from an authenticated common finalized base', async () => {
  const different = chain(101, 1050, 3_000_000, new Map([...main].filter(([h]) => h <= 100)));
  const plan = await planSegmentedSeal({ ...opts, source: source(different), proof: proofAt(fork, 356) });
  assert.equal(plan.action, 'begin');
  assert.equal(plan.base, states[100]);
});

test('candidate through its old target is restarted when the fork is after that target', async () => {
  const later = chain(661, 1100, 4_000_000, new Map([...main].filter(([h]) => h <= 660)));
  const plan = await planSegmentedSeal({ ...opts, tip: tipAt(700), source: source(later), proof: proofAt(main, 356) });
  assert.equal(plan.action, 'begin');
  assert.equal(plan.forkBase, 657);
});

test('source lag, insufficient work and missing base have explicit bounded outcomes', async () => {
  assert.deepEqual(await planSegmentedSeal({ ...opts, source: source(main) }), { action: 'none' });
  const short = new Map([...fork].filter(([h]) => h <= 800));
  let plan = await planSegmentedSeal({ ...opts, source: source(short), proof: proofAt(fork, 800) });
  assert.equal(plan.action, 'wait'); assert.match(plan.reason, /threshold/);
  plan = await planSegmentedSeal({ ...opts, source: source(short), proof: proofAt(fork, 901) });
  assert.equal(plan.action, 'wait'); assert.match(plan.reason, /behind/);
  plan = await planSegmentedSeal({ ...opts, states: { 600: states[600] } });
  assert.equal(plan.action, 'wait'); assert.match(plan.reason, /no saved/);
});

test('malformed proof, invalid bounds and nonlinking source data are rejected', async () => {
  assert.throws(() => decodeReorgProof('0x1234'), /encoding/);
  await assert.rejects(planSegmentedSeal({ ...opts, maxHeaders: 257 }), /limit/);
  const good = source(fork);
  const broken = { ...good, at: async h => h === 101 ? { header: main.get(103).toString('hex') } : good.at(h) };
  await assert.rejects(planSegmentedSeal({ ...opts, source: broken }), /does not link/);
});

test('state cache retains its earliest known anchor as recent states rotate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuji-segments-'));
  try {
    const file = path.join(dir, 'states.json');
    for (let h = 100; h < 200; h++) saveState(file, state(main, h));
    const saved = loadStates(file);
    assert.equal(Object.keys(saved).length, 65);
    assert.equal(saved[100], state(main, 100));
    assert.equal(saved[199], state(main, 199));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('receipt decoding checks address, status, uniqueness and complete state length', () => {
  const proof = proofAt(fork, 356);
  assert.equal(proofFromReceipt(receipt(proof), index), proof);
  assert.throws(() => proofFromReceipt(null, index), /unavailable/);
  assert.throws(() => proofFromReceipt({ ...receipt(proof), status: '0x0' }, index), /failed/);
  assert.throws(() => proofFromReceipt(receipt(proof), '0x' + '22'.repeat(20)), /one/);
  const duplicate = receipt(proof); duplicate.logs.push(duplicate.logs[0]);
  assert.throws(() => proofFromReceipt(duplicate, index), /one/);
  const malformed = receipt(proof); malformed.logs[0].data += '00';
  assert.throws(() => proofFromReceipt(malformed, index), /encoding/);
});

test('submission saves the mined proof when target changed after simulation, not the simulated one', async () => {
  const plan = await planSegmentedSeal(opts), simulated = proofAt(fork, 356), mined = proofAt(fork, 356, tipAt(667));
  const calls = [], saved = [];
  const chain = {
    simulate: async (_to, sig, ...args) => {
      calls.push(['simulate', sig]);
      if (sig.startsWith('isReorgProof')) { assert.equal(args[0], mined); return 'true'; }
      return simulated;
    },
    send: async (sig, gas, args) => {
      calls.push(['send', sig]); assert.ok(gas < 8_000_000); assert.equal(args[0], plan.base);
      return { hash: '0x1234', gas: 5_000_000 };
    },
    rpc: async (method, args) => { assert.equal(method, 'eth_getTransactionReceipt'); assert.deepEqual(args, ['0x1234']); return receipt(mined); },
  };
  const result = await submitReorgStep({ chain, index, plan, saveProof: proof => saved.push(proof) });
  assert.equal(result.action, 'reorg-progress'); assert.deepEqual(saved, [mined]);
  assert.deepEqual(calls.map(c => c[0]), ['simulate', 'send', 'simulate']);
});

test('failed or stale submission does not overwrite resumable state', async () => {
  const plan = await planSegmentedSeal(opts), saved = [];
  const chain = { simulate: async () => { throw Error('rejected'); }, send: async () => { assert.fail('must not send'); } };
  await assert.rejects(submitReorgStep({ chain, index, plan, saveProof: p => saved.push(p) }), /rejected/);
  assert.deepEqual(saved, []);
  chain.simulate = async (_to, sig) => sig.startsWith('isReorgProof') ? 'false' : '';
  chain.send = async () => ({ hash: '0x1234' });
  chain.rpc = async () => receipt(proofAt(fork, 356));
  await assert.rejects(submitReorgStep({ chain, index, plan, saveProof: p => saved.push(p) }), /not authenticated/);
  assert.deepEqual(saved, []);
});

test('finalization is separately simulated and clears progress only after successful send', async () => {
  const proof = proofAt(fork, 901), saved = [], calls = [];
  const chain = {
    simulate: async (_to, sig, arg) => { calls.push(sig); assert.equal(arg, proof); },
    send: async (sig, gas, args) => { calls.push(sig); assert.equal(gas, 200_000); assert.deepEqual(args, [proof]); return { hash: '0x1234' }; },
  };
  const result = await submitReorgStep({ chain, index, plan: { action: 'finish', proof }, saveProof: p => saved.push(p) });
  assert.equal(result.action, 'sealed'); assert.deepEqual(saved, [null]);
  assert.deepEqual(calls, ['freezeReorg(bytes)', 'freezeReorg(bytes)']);
});
