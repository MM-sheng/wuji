// Regression for the legacy pool's reachable missing-hash state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markFromHeaders } from './accounts.mjs';

test('review: the keeper bypasses a legacy price mark without a hash', async () => {
  const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const pool = '0x' + 'aa'.repeat(20), index = '0x' + 'bb'.repeat(20);
  const queue = [1000, 1990], attempts = [], sends = [];
  const read = async (to, data) => {
    const sel = data.slice(0, 10);
    const arg = data.length > 10 ? Number(BigInt('0x' + data.slice(10, 74))) : 0;
    if (to === index) return word(2000);
    if (sel === '0x8f7dcfa3') return word(0);
    if (sel === '0xab91c7b0') return word(queue.length);
    if (sel === '0xddf0b009') return word(queue[arg]);
    if (sel === '0x515f805e') return word(arg === 1990 ? 1 : 0);
    if (sel === '0x7c4b99b8') return word(0);
    throw Error('unexpected selector ' + sel);
  };
  // The Solidity companion reproduction establishes that this state is reachable and
  // markWithHeaders rejects the selected base because hashAt(1990) is zero.
  const simulate = async (_to, _sig, h, top) => {
    attempts.push([Number(h), Number(top)]);
    if (Number(top) === 1990) throw Error('execution reverted: unknown base');
  };
  const run = () => markFromHeaders({
    read, simulate, send: async (...args) => sends.push(args), pool, index,
    headersFor: async (from, to) => '0x' + 'ab'.repeat(80 * (to - from + 1)),
  });
  await run();
  assert.deepEqual(attempts, [[1000, 2000]]);
  assert.equal(sends.length, 1);
});
