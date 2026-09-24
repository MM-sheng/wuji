import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HeaderChain, targetOf, compact, retarget, varint, readVarint, frame } from './bitcoin-p2p.mjs';
import { step } from './bitcoin.mjs';

const GENESIS = Buffer.from(
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e'
  + '67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c', 'hex');
const meta = JSON.parse(fs.readFileSync('contracts/test/fixtures/bitcoin.json', 'utf8'));

test('compact target round-trips and matches the relay contract rules', () => {
  for (const bits of [0x1d00ffff, 0x17053894, 0x1702ffff, 0x170355f0]) {
    assert.equal(compact(targetOf(bits)), bits, `round trip ${bits.toString(16)}`);
  }
  assert.throws(() => targetOf(0x1d80ffff), /target sign\/zero/);   // sign bit set
  assert.throws(() => targetOf(0x1e00ffff), /target range/);        // above the PoW limit
});

test('retarget applies the x4 / /4 clamp like Bitcoin Core', () => {
  const bits = 0x17053894;
  assert.equal(retarget(bits, 100, 99), compact(targetOf(bits) / 4n), 'fast epoch clamps to /4');
  assert.equal(retarget(bits, 100, 10_000_000), compact(targetOf(bits) * 4n), 'slow epoch clamps to x4');
  assert.equal(retarget(0x1d00ffff, 0, 10_000_000), 0x1d00ffff, 'never easier than the PoW limit');
});

test('genesis validates and a tampered header is rejected', () => {
  const chain = new HeaderChain();
  assert.equal(chain.append(GENESIS), 0);
  assert.equal(chain.hashes[0], '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  assert.equal(chain.locator().length, 1, 'a one-block chain still yields a usable locator');

  const wrong = new HeaderChain();
  const flipped = Buffer.from(GENESIS); flipped[76] ^= 1;          // change the nonce
  assert.throws(() => wrong.append(flipped), /wrong genesis/);

  const short = new HeaderChain();
  assert.throws(() => short.append(GENESIS.subarray(0, 79)), /80 bytes/);
});

test('a child that does not link to the tip is rejected', () => {
  const chain = new HeaderChain();
  chain.append(GENESIS);
  const orphan = Buffer.alloc(80);
  orphan.writeUInt32LE(1, 0);
  orphan.writeUInt32LE(0x1d00ffff, 72);
  assert.throws(() => chain.append(orphan), /linkage at 1/);
});

test('the committed fixture header agrees with our step() digest order', () => {
  const hex = fs.readFileSync('contracts/test/fixtures/bitcoin-798336.hex', 'utf8').trim().replace(/^0x/, '');
  const buf = Buffer.from(hex, 'hex');
  const at800000 = buf.subarray((800000 - 798336) * 80, (800000 - 798336 + 1) * 80);
  const s = step(at800000);
  assert.equal(s.hash, meta.known800000.hash);
  assert.equal(s.R, meta.known800000.R);
  assert.equal(s.delta, meta.known800000.delta);
});

test('wire encoding round-trips', () => {
  for (const n of [0, 1, 0xfc, 0xfd, 0xffff, 0x10000, 0xffffffff, 0x100000000]) {
    const [value, offset] = readVarint(varint(n), 0);
    assert.equal(value, n);
    assert.equal(offset, varint(n).length);
  }
  const f = frame('getheaders', Buffer.from('cafe', 'hex'));
  assert.equal(f.readUInt32LE(0), 0xd9b4bef9, 'mainnet magic');
  assert.equal(f.subarray(4, 16).toString('ascii').replace(/\0+$/, ''), 'getheaders');
  assert.equal(f.readUInt32LE(16), 2, 'payload length');
});

// Opt-in: a full validated chain produced by a real P2P sync (see docs, not run in CI).
test('a synced header file validates from genesis and matches every fixture header', { skip: !process.env.WUJI_HEADER_FILE }, () => {
  const chain = new HeaderChain();
  const count = chain.load(process.env.WUJI_HEADER_FILE);
  assert.ok(count > 800_000, `expected a long chain, got ${count}`);
  const hex = fs.readFileSync('contracts/test/fixtures/bitcoin-798336.hex', 'utf8').trim().replace(/^0x/, '');
  const buf = Buffer.from(hex, 'hex');
  for (let i = 0; i * 80 < buf.length; i++) {
    assert.equal(chain.headers[798336 + i].toString('hex'), buf.subarray(i * 80, (i + 1) * 80).toString('hex'));
  }
});

test('a peer that never completes the handshake cannot crash the process', async () => {
  // Regression: the handshake creates the `verack` waiter before awaiting `version`. When `version`
  // timed out first, nothing awaited `verack`, and Node killed the indexer on the unhandled rejection.
  const net = await import('node:net');
  const server = net.createServer(socket => socket.on('data', () => {})); // accept, then stay silent
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const rejections = [];
  const onUnhandled = reason => rejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { BitcoinP2P } = await import('./bitcoin-p2p.mjs');
    const api = new BitcoinP2P({ peers: [`127.0.0.1:${port}`], dir: '/tmp/wuji-p2p-test-' + port, peerTimeout: 300 });
    api.chain.append(Buffer.from(
      '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e'
      + '67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c', 'hex'));
    api.chain.headers.length = 1;
    await assert.rejects(() => api.sync({ force: true }), /no (version|verack|headers) from peer|peer timeout/);
    await new Promise(resolve => setTimeout(resolve, 50)); // let any orphaned rejection surface
    assert.deepEqual(rejections, [], 'no unhandled rejection escaped');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    server.close();
  }
});
