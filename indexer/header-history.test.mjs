import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { step } from './bitcoin.mjs';
import { markFromHeaders } from './accounts.mjs';
import { HeaderHistory, headersFromFoldCalldata, recoverFoldTransaction } from './header-history.mjs';

// Synthetic headers test hash authentication and branch choice; production PoW is the index's responsibility.
function branch(salt, prefix = []) {
  const headers = [...prefix];
  for (let h = headers.length; h <= 20; h++) {
    const b = Buffer.alloc(80);
    b.writeInt32LE(4); if (h) Buffer.from(step(headers[h - 1]).internalHash, 'hex').copy(b, 4);
    b.writeUInt32LE(h + salt, 36); b.writeUInt32LE(1_700_000_000 + 600 * h, 68); b.writeUInt32LE(0x207fffff, 72);
    headers.push(b.toString('hex'));
  }
  return headers;
}
const old = branch(100), replacement = branch(200, old.slice(0, 4));
const anchor = (headers, h) => '0x' + step(headers[h]).internalHash;
const source = headers => ({ at: async h => ({ header: headers[h] }) });
const w = n => BigInt(n).toString(16).padStart(64, '0');
function archive(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuji-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return new HeaderHistory(dir);
}
const concat = (headers, from, to) => '0x' + headers.slice(from, to + 1).join('');
function calldata(headers) {
  const raw = headers.replace(/^0x/, ''), padded = raw.padEnd(Math.ceil(raw.length / 64) * 64, '0');
  return '0xdca3930f' + w(64) + w(64 + 32 + padded.length / 2) + w(raw.length / 2) + padded + w(0);
}

test('persisted old branch survives restart and a source that only serves the new chain', async t => {
  const history = archive(t);
  history.putBatch(old);
  const restarted = new HeaderHistory(history.directory);
  const unavailable = { at: async () => { assert.fail('archived data must not fetch current heights'); } };
  assert.equal(await restarted.headersFor(unavailable, 5, 10, anchor(old, 10)), concat(old, 5, 10));
  history.putBatch(replacement);
  assert.equal(await restarted.headersFor(source(replacement), 5, 10, anchor(old, 10)), concat(old, 5, 10));
  assert.equal(await restarted.headersFor(source(old), 5, 10, anchor(replacement, 10)), concat(replacement, 5, 10));
});

test('missing orphan headers are fetched by display hash and walked backwards from the raw anchor', async t => {
  const history = archive(t), requested = [];
  const byHash = new Map(old.map(h => [step(h).hash, h]));
  const remote = {
    at: async () => { assert.fail('do not need a height lookup'); },
    header: async hash => { requested.push(hash); return byHash.get(hash); },
  };
  assert.equal(await history.headersFor(remote, 5, 10, anchor(old, 10)), concat(old, 5, 10));
  assert.deepEqual(requested, old.slice(5, 11).reverse().map(h => step(h).hash));
  assert.equal(history.get(anchor(old, 5)), old[5]);
});

test('a current-height fallback is accepted only when its bytes match the expected hash', async t => {
  const history = archive(t);
  assert.equal(await history.headersFor(source(old), 5, 10, anchor(old, 10)), concat(old, 5, 10));
  await assert.rejects(history.headersFor(source(replacement), 11, 15, anchor(old, 15)), /unavailable at 15/);
  assert.equal(history.get(anchor(replacement, 15)), null);
});

test('wrong branch from both hash and height endpoints never reaches the caller', async t => {
  const history = archive(t);
  const dishonest = { ...source(replacement), header: async () => replacement[10] };
  await assert.rejects(history.headersFor(dishonest, 5, 10, anchor(old, 10)), /unavailable at 10/);
  assert.equal(history.get(anchor(replacement, 10)), null);
});

test('missing intermediate old header cannot be replaced by the same height on a new fork', async t => {
  const history = archive(t);
  history.put(old[10]); history.put(old[9]);
  await assert.rejects(history.headersFor(source(replacement), 5, 10, anchor(old, 10)), /unavailable at 8/);
});

test('corrupt on-disk headers are rejected instead of used as authentication anchors', async t => {
  const history = archive(t);
  history.put(old[10]);
  fs.writeFileSync(history.file(anchor(old, 10)), Buffer.from(replacement[10], 'hex'));
  await assert.rejects(history.headersFor(source(old), 5, 10, anchor(old, 10)), /corrupt archived/);
});

test('range and anchor checks reject unanchored, oversized and path-like inputs', async t => {
  const history = archive(t);
  for (const bad of [undefined, '0x' + '00'.repeat(32), '../../file', '0x1234']) {
    await assert.rejects(history.headersFor(source(old), 5, 10, bad), /anchor hash/);
  }
  for (const [from, to] of [[0, 1024], [10, 9], [-1, 1], [0.5, 10]]) {
    await assert.rejects(history.headersFor(source(old), from, to, anchor(old, 10)), /range/);
  }
});

test('broken batch is rejected before any header is persisted; writes leave no temp files', t => {
  const history = archive(t);
  assert.throws(() => history.putBatch([old[5], replacement[6]]), /does not link/);
  assert.equal(history.get(anchor(old, 5)), null);
  history.putBatch(old.slice(5, 11));
  history.putBatch(old.slice(5, 11)); // idempotent persistence
  for (const dir of fs.readdirSync(history.directory)) {
    assert.ok(fs.readdirSync(path.join(history.directory, dir)).every(f => f.endsWith('.bin')));
  }
});

test('public successful fold calldata recovers orphan headers without a Bitcoin archive source', async t => {
  const history = archive(t), input = calldata(concat(old, 1, 20));
  assert.equal(headersFromFoldCalldata(input), concat(old, 1, 20));
  const transactionHash = '0x' + '12'.repeat(32), index = '0x' + '34'.repeat(20), calls = [];
  const rpc = async (method, args) => {
    calls.push(method); assert.deepEqual(args, [transactionHash]);
    return method === 'eth_getTransactionByHash' ? { hash: transactionHash, to: index, input }
      : { transactionHash, status: '0x1' };
  };
  assert.equal(await recoverFoldTransaction({ history, rpc, index, transactionHash }), 20);
  assert.deepEqual(calls, ['eth_getTransactionByHash', 'eth_getTransactionReceipt']);
  assert.equal(await history.headersFor(source(replacement), 5, 10, anchor(old, 10)), concat(old, 5, 10));
});

test('invalid selector, length, offset, failed receipt and wrong target cannot import recovery data', async t => {
  const history = archive(t), input = calldata(concat(old, 1, 2));
  for (const bad of ['0x12345678' + input.slice(10), input.slice(0, 40), '0xdca3930f' + 'ff'.repeat(32),
    '0xdca3930f' + w(32) + input.slice(74)]) assert.throws(() => headersFromFoldCalldata(bad));
  const transactionHash = '0x' + '12'.repeat(32), index = '0x' + '34'.repeat(20);
  for (const [to, status] of [[index, '0x0'], ['0x' + '56'.repeat(20), '0x1']]) {
    const rpc = async method => method === 'eth_getTransactionByHash' ? { hash: transactionHash, to, input } : { transactionHash, status };
    await assert.rejects(recoverFoldTransaction({ history, rpc, index, transactionHash }), /not a successful/);
  }
  assert.equal(history.get(anchor(old, 1)), null);
});

test('actual keeper planner passes the final tip and intermediate on-chain hashes to old-chain recovery', async t => {
  const history = archive(t); history.putBatch(old);
  const pool = 'pool', index = 'index', marks = new Map(), calls = [], queue = [5, 7];
  const read = async (to, data) => {
    const selector = data.slice(0, 10), n = data.length > 10 ? Number(BigInt('0x' + data.slice(10))) : 0;
    if (to === index) return selector === '0x3fa21806' ? anchor(old, 10) : '0x' + w(10);
    if (selector === '0x8f7dcfa3') return '0x' + w(0);
    if (selector === '0xab91c7b0') return '0x' + w(queue.length);
    if (selector === '0xddf0b009') return '0x' + w(queue[n]);
    if (selector === '0x515f805e') return '0x' + w(marks.has(n) ? 1 : 0);
    if (selector === '0x7c4b99b8') return marks.get(n) || '0x' + w(0);
    throw Error('unexpected selector');
  };
  const done = await markFromHeaders({ pool, index, read,
    headersFor: async (from, to, expected) => {
      calls.push([from, to, expected]); return history.headersFor(source(replacement), from, to, expected);
    },
    simulate: async (_to, _sig, h, to, headers) => assert.equal(headers, concat(old, Number(h) + 1, Number(to))),
    send: async (_to, _sig, _gas, h) => marks.set(Number(h), anchor(old, Number(h))),
  });
  assert.equal(done.length, 2);
  assert.deepEqual(calls, [[8, 10, anchor(old, 10)], [6, 7, anchor(old, 7)]]);
});

test('real mainnet fixture headers are restored byte for byte from an authenticated historical tip', async t => {
  const history = archive(t);
  const fixture = fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin-timestamps.hex', import.meta.url), 'utf8').trim().replace(/^0x/, '');
  const headers = fixture.slice(0, 12 * 160).match(/.{160}/g);
  history.putBatch(headers);
  const neverFetch = { at: async () => { throw Error('source has reorganized'); } };
  assert.equal(await history.headersFor(neverFetch, 798340, 798347, '0x' + step(headers[11]).internalHash), '0x' + headers.slice(4).join(''));
});
