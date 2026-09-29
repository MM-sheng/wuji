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
