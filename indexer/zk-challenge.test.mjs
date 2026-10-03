import test from 'node:test'; import assert from 'node:assert/strict';
import { decodeBatch, decodeContinuity, differences, replay, sel } from './zk-challenge.mjs';
import { watch } from './zk-watcher.mjs';
import { step } from './bitcoin.mjs';
import { encodeBatch, encodeContinuity, fixture, header, journal, w } from './zk-test-helpers.mjs';

test('the JavaScript replay reaches exactly the state the Rust guest proves (100 headers)', () => {
  const j = journal(fixture('zk-journal.hex'));
  const truth = replay(j.prev, Array.from({ length: 100 }, (_, i) => header(i)), j);
  assert.deepEqual(differences(j, truth), []);
  assert.equal(truth.to.height, j.prev.height + 94);
});

test('the replay collects checkpoints like the guest (interval 100, 200 headers)', () => {
  const j = journal(fixture('zk-journal-checkpoints.hex'));
  assert.equal(j.checkpointInterval, 100);
  const truth = replay(j.prev, Array.from({ length: 200 }, (_, i) => header(i)), j);
  assert.deepEqual(differences(j, truth), []);
  assert.equal(truth.checkpointHeights.length, 1);
});

test('a forged claim is reported field by field', () => {
  const j = journal(fixture('zk-journal.hex'));
  const truth = replay(j.prev, Array.from({ length: 100 }, (_, i) => header(i)), j);
  const forged = { ...j, to: { ...j.to, u: String(BigInt(j.to.u) + 1n) } };
  assert.deepEqual(differences(forged, truth), ['u']);
});

test('batch(id) decodes, including checkpoint arrays and a negative U', () => {
  const j = journal(fixture('zk-journal-checkpoints.hex'));
  const b = { to: { ...j.to, u: '-17' }, checkpointHeights: j.checkpointHeights, checkpointU: ['-3'], prover: '0x' + '11'.repeat(20),
    finalAt: 1800000000, disputer: '0x' + '22'.repeat(20), respondBy: 1800021600, backed: true };
  const d = decodeBatch(encodeBatch(b));
  assert.deepEqual(d, { ...b, to: { ...b.to } });
  assert.deepEqual(decodeContinuity(encodeContinuity(j.prev)), j.prev);
});

// ---------------------------------------------------------------- watcher decisions

function fakeChain({ batches, start, now }) {
  const sent = [];
  const at = data => BigInt('0x' + data.slice(10));
  const views = {
    [sel('firstPending()')]: () => '0x' + w(0), [sel('nextBatch()')]: () => '0x' + w(batches.length),
    [sel('GENESIS_HEIGHT()')]: () => '0x' + w(start.genesisHeight), [sel('CHECKPOINT_INTERVAL()')]: () => '0x' + w(4320),
    [sel('CONFIRMATIONS()')]: () => '0x' + w(6), [sel('DISPUTE_BOND()')]: () => '0x' + w(5n * 10n ** 16n),
    [sel('batch(uint256)')]: d => encodeBatch(batches[Number(at(d))]),
    [sel('stateBefore(uint256)')]: d => encodeContinuity(Number(at(d)) === 0 ? start.state : batches[Number(at(d)) - 1].to),
  };
  return {
    sent,
    call: async data => views[data.slice(0, 10)](data),
    rpc: async m => (m === 'eth_getBlockByNumber' ? { timestamp: '0x' + now.toString(16) } : null),
    send: async (sig, gas, args, value) => { sent.push({ sig, args, value }); return { hash: '0x', gas: 0 }; },
  };
}

function setup({ forge, disputed, now }) {
  const j = journal(fixture('zk-journal.hex'));
  const source = { tip: async () => j.prev.height + 6060, at: async h => { const x = header(h - j.prev.height - 1); return { header: x, hash: step(x).hash }; } };
  const to = forge ? { ...j.to, u: String(BigInt(j.to.u) + 5n) } : j.to;
  const batch = { to, checkpointHeights: [], checkpointU: [], prover: '0x' + '11'.repeat(20), finalAt: 1000,
    disputer: disputed ? '0x' + '22'.repeat(20) : '0x' + '0'.repeat(40), respondBy: disputed ? 2000 : 0, backed: false };
  const chain = fakeChain({ batches: [batch], start: { state: j.prev, genesisHeight: j.genesisHeight }, now });
  return { chain, sources: [source, source] };
}

test('the watcher disputes a forged batch inside its window, with the bond, and refutes it at once', async () => {
  const { chain, sources } = setup({ forge: true, disputed: false, now: 500 });
  await watch({ chain, sources });
  assert.deepEqual(chain.sent.map(s => s.sig), ['dispute(uint256,address[])', 'refute(uint256,bytes,address[])']);
  assert.equal(chain.sent[0].value, 5n * 10n ** 16n);
  assert.equal(chain.sent[1].args[1].length, 2 + 100 * 160, 'the same headers back would use');
});

test('the watcher backs an honest disputed batch with the exact headers', async () => {
  const { chain, sources } = setup({ forge: false, disputed: true, now: 1500 });
  await watch({ chain, sources });
  assert.equal(chain.sent[0].sig, 'back(uint256,bytes)');
  assert.equal(chain.sent[0].args[1].length, 2 + 100 * 160, '94 folded + 6 confirmations');
  // the fake chain does not apply `back`, so the batch still reads as unbacked: no finalize yet
  assert.equal(chain.sent.length, 1);
});

test('the watcher refutes a batch someone else disputed, and falls back to reject after the window', async () => {
  let { chain, sources } = setup({ forge: true, disputed: true, now: 1500 });
  await watch({ chain, sources });
  assert.deepEqual(chain.sent.map(s => s.sig), ['refute(uint256,bytes,address[])']);

  ({ chain, sources } = setup({ forge: true, disputed: true, now: 2001 }));
  const send = chain.send;
  chain.send = async (sig, ...rest) => { if (sig.startsWith('refute')) throw Error('reverted'); return send(sig, ...rest); };
  await watch({ chain, sources });
  assert.deepEqual(chain.sent.map(s => s.sig), ['reject(uint256)']);
});

test('the watcher only reports a forgery whose window has closed undisputed', async () => {
  const { chain, sources } = setup({ forge: true, disputed: false, now: 1000 });
  await watch({ chain, sources });
  assert.deepEqual(chain.sent, []);
});

test('the watcher finalizes an honest batch past its window and leaves honest open ones alone', async () => {
  let { chain, sources } = setup({ forge: false, disputed: false, now: 1000 });
  await watch({ chain, sources });
  assert.deepEqual(chain.sent.map(s => s.sig), ['finalize(uint256)']);
  ({ chain, sources } = setup({ forge: false, disputed: false, now: 999 }));
  await watch({ chain, sources });
  assert.deepEqual(chain.sent, []);
});

test('the watcher does not act when its two sources disagree', async () => {
  const { chain, sources } = setup({ forge: true, disputed: false, now: 500 });
  const liar = { ...sources[0], at: async () => ({ header: '', hash: 'ff'.repeat(32) }) };
  await watch({ chain, sources: [sources[0], liar] });
  assert.deepEqual(chain.sent, []);
});
