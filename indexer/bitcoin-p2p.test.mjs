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

// ---------------------------------------------------------------- fork choice (applyHeaders)

/// Same bookkeeping as HeaderChain, but "work" is byte 72 and byte 76 = 0xff marks an invalid header, so
/// branches can be built without mining. Fork choice is what is under test, not the header rules.
async function forkChoice() {
  const { HeaderChain, applyHeaders } = await import('./bitcoin-p2p.mjs');
  const { sha256d } = await import('./bitcoin.mjs');
  class TestChain extends HeaderChain {
    append(raw) {
      const height = this.headers.length;
      if (height > 0 && raw.subarray(4, 36).toString('hex') !== sha256d(this.headers[height - 1]).toString('hex')) throw Error(`linkage at ${height}`);
      if (raw[76] === 0xff) throw Error(`difficulty at ${height}`);
      this.headers.push(raw); this.hashes.push(Buffer.from(sha256d(raw)).reverse().toString('hex'));
      this.work += this.headerWork(raw); return height;
    }
    headerWork(raw) { return BigInt(raw[72]); }
  }
  const header = (parent, work, salt, bad = false) => {
    const h = Buffer.alloc(80); h.writeUInt32LE(salt, 0);
    if (parent) sha256d(parent).copy(h, 4);
    h[72] = work; if (bad) h[76] = 0xff; return h;
  };
  const branch = (from, n, work, salt, badAt = -1) => {
    const out = []; let p = from;
    for (let i = 0; i < n; i++) { p = header(p, work, salt + i, i === badAt); out.push(p); }
    return out;
  };
  const chain = new TestChain();
  chain.append(header(null, 1, 0));
  for (const h of branch(chain.headers[0], 20, 10, 100)) chain.append(h);   // heights 1..20, work 10 each
  return { chain, branch, applyHeaders };
}

test('a reply that extends the tip is appended', async () => {
  const { chain, branch, applyHeaders } = await forkChoice();
  const r = await applyHeaders(chain, branch(chain.headers[20], 3, 10, 500), async () => []);
  assert.equal(r.added, 3); assert.equal(chain.height, 23);
});

test('a lighter fork is ignored and the chain keeps every validated header', async () => {
  const { chain, branch, applyHeaders } = await forkChoice();
  const tip = chain.hashes[20], logs = [];
  // From 12: nine headers of work 5 (45) against our eight of work 10 (80) above 12.
  const r = await applyHeaders(chain, branch(chain.headers[12], 9, 5, 900), async () => [], m => logs.push(m));
  assert.equal(r.added, 0); assert.equal(chain.height, 20); assert.equal(chain.hashes[20], tip);
  assert.match(logs.join('\n'), /ignored a branch from 12/);
});

test('a heavier fork from below the tip replaces it', async () => {
  const { chain, branch, applyHeaders } = await forkChoice();
  const logs = [];
  // From 12: nine headers of work 10 (90) against 80.
  const r = await applyHeaders(chain, branch(chain.headers[12], 9, 10, 900), async () => [], m => logs.push(m));
  assert.ok(r.added > 0); assert.equal(chain.height, 21);
  assert.match(logs.join('\n'), /reorg at 12, 20 → 21/);
});

test('an invalid fork throws and leaves the chain untouched (the 961640 case)', async () => {
  const { chain, branch, applyHeaders } = await forkChoice();
  const tip = chain.hashes[20], work = chain.work;
  await assert.rejects(applyHeaders(chain, branch(chain.headers[5], 30, 10, 700, 8), async () => []), /difficulty at 14/);
  assert.equal(chain.height, 20); assert.equal(chain.hashes[20], tip); assert.equal(chain.work, work);
});

test('a heavier fork is adopted, fetching more replies while it is still lighter', async () => {
  const { chain, branch, applyHeaders } = await forkChoice();
  // 2000 headers of work 0 cannot beat 15 × 10; the next reply (work 10 each) does.
  const first = branch(chain.headers[5], 2000, 0, 10_000);
  let asked = 0;
  const more = async () => { asked++; return branch(first.at(-1), 20, 10, 50_000); };
  const r = await applyHeaders(chain, first, more);
  assert.equal(asked, 1);
  assert.equal(chain.height, 5 + 2000 + 20);
  assert.ok(r.added > 0);
});

test('a reply from an unknown branch changes nothing', async () => {
  const { chain, branch, applyHeaders } = await forkChoice();
  const stranger = branch(Buffer.alloc(80, 7), 5, 50, 1);
  const r = await applyHeaders(chain, stranger, async () => []);
  assert.equal(r.added, 0); assert.equal(chain.height, 20);
});
