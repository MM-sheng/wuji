import test from 'node:test'; import assert from 'node:assert/strict';
process.env.RPC ||= 'http://127.0.0.1:1'; process.env.CHAIN_ID ||= '31337';
process.env.ZK_INDEX ||= '0x' + '11'.repeat(20); process.env.ZK_UNLOCKED_FROM ||= '0x' + '22'.repeat(20);
const { decodeContinuity } = await import('./zk-keeper.mjs');
const w = n => (BigInt.asUintN(256, BigInt(n))).toString(16).padStart(64, '0');
test('continuity() decodes into the host input shape, including a negative U', () => {
  const hash = 'ab'.repeat(32);
  const hex = '0x' + hash + w(798429) + w(0x17053894) + w(1700000000) + w(1699000000) + w(-2017)
    + Array.from({ length: 11 }, (_, i) => w(1699999000 + i)).join('') + w(123456789n);
  const c = decodeContinuity(hex);
  assert.equal(c.hash, '0x' + hash); assert.equal(c.height, 798429); assert.equal(c.bits, 0x17053894);
  assert.equal(c.u, '-2017'); assert.equal(c.recentTimes.length, 11); assert.equal(c.recentTimes[10], 1699999010);
  assert.equal(BigInt(c.work), 123456789n);
  assert.throws(() => decodeContinuity('0x1234'));
});

test('a Bitcoin source that never answers fails the round instead of hanging the keeper', async () => {
  process.env.ZK_SOURCE_TIMEOUT_S = '0.2';
  const { round } = await import('./zk-keeper.mjs?timeout');
  const rpcStub = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    const result = method === 'eth_chainId' ? '0x7a69' : '0x' + '0'.repeat(1152);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  try {
    const hanging = { tip: () => new Promise(() => {}), at: () => new Promise(() => {}) };
    await assert.rejects(round(hanging), /timed out/);
  } finally { globalThis.fetch = rpcStub; }
});

test('the keeper does not prove on top of a pending batch that does not match the chain', async () => {
  const { encodeBatch, encodeContinuity, fixture, header, journal, w } = await import('./zk-test-helpers.mjs');
  const { sel } = await import('./zk-challenge.mjs');
  const { step } = await import('./bitcoin.mjs');
  const j = journal(fixture('zk-journal.hex'));
  // A forgery that keeps the real end hash but claims a different U: it still links, so only replay catches it.
  const batch = { to: { ...j.to, u: String(BigInt(j.to.u) + 7n) }, checkpointHeights: [], checkpointU: [],
    prover: '0x' + '11'.repeat(20), finalAt: 1000, disputer: '0x' + '0'.repeat(40), respondBy: 0, backed: false };
  const views = {
    [sel('GENESIS_HEIGHT()')]: w(j.genesisHeight), [sel('CHECKPOINT_INTERVAL()')]: w(4320), [sel('CONFIRMATIONS()')]: w(6),
    [sel('MAX_HEADERS()')]: w(512), [sel('MAX_PROOF_HEADERS()')]: w(250), [sel('pendingCount()')]: w(1),
    [sel('finalize(uint256)')]: w(0), [sel('firstPending()')]: w(0), [sel('nextBatch()')]: w(1),
    [sel('DISPUTE_BOND()')]: w(1), [sel('verifier()')]: w(0x5f1), // a proof-path index
  };
  const rpcStub = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    let result;
    if (method === 'eth_chainId') result = '0x7a69';
    else if (method === 'eth_getBlockByNumber') result = { timestamp: '0x1f4' };
    else {
      const data = params[0].data, s = data.slice(0, 10);
      if (s === sel('batch(uint256)')) result = encodeBatch(batch);
      else if (s === sel('stateBefore(uint256)')) result = encodeContinuity(j.prev);
      else if (s === sel('continuity()')) result = encodeContinuity(batch.to);
      else result = '0x' + views[s];
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  try {
    const { round } = await import('./zk-keeper.mjs?guard');
    const source = { tip: async () => j.prev.height + 6060, at: async h => { const x = header(h - j.prev.height - 1); return { header: x, hash: step(x).hash }; } };
    const r = await round(source);
    assert.equal(r.action, 'blocked');
  } finally { globalThis.fetch = rpcStub; }
});
