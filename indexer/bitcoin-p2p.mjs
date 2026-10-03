// Bitcoin P2P header client — sync the header chain straight from the network, no HTTP API, no third party.
//
// The whole header chain is 80 bytes × height ≈ 77 MB, minutes to download, and every header proves its own
// work. We validate exactly what BitcoinRelay.sol validates — PoW against nBits, parent linkage, retarget with
// the ×4/÷4 clamp — so a peer can only feed us a chain it actually mined. Fork choice is cumulative work.
//
// This removes the protocol's last liveness single point: a keeper no longer depends on anyone's API quota.
//
//   BITCOIN_SOURCE=p2p [BITCOIN_P2P_PEERS=host:port,...] [BITCOIN_P2P_DIR=indexer/data/headers]
//
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { sha256d, step } from './bitcoin.mjs';

const MAGIC = 0xd9b4bef9;                 // mainnet, little-endian on the wire
const PORT = 8333;
const PROTOCOL = 70016;
const MAX_HEADERS = 2000;                 // per `headers` message, protocol maximum
const RETARGET = 2016;
const TARGET_TIMESPAN = 14 * 24 * 60 * 60;
const POW_LIMIT = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
// The mainnet genesis header. Every Bitcoin client hardcodes it; a `getheaders` locator cannot be empty,
// and this is the one header nobody can serve us because it has no parent to link from.
const GENESIS_HEADER = Buffer.from(
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e'
  + '67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c', 'hex');
const SEEDS = [
  'seed.bitcoin.sipa.be', 'dnsseed.bluematt.me', 'seed.bitcoinstats.com',
  'seed.bitcoin.jonasschnelli.ch', 'seed.btc.petertodd.net', 'seed.bitcoin.sprovoost.nl',
  'dnsseed.emzy.de', 'seed.bitcoin.wiz.biz',
];

// ---------- wire format ----------
export function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(BigInt(n), 1); return b;
}
export function readVarint(buf, offset) {
  const first = buf[offset];
  if (first < 0xfd) return [first, offset + 1];
  if (first === 0xfd) return [buf.readUInt16LE(offset + 1), offset + 3];
  if (first === 0xfe) return [buf.readUInt32LE(offset + 1), offset + 5];
  return [Number(buf.readBigUInt64LE(offset + 1)), offset + 9];
}
export function frame(command, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(24);
  head.writeUInt32LE(MAGIC, 0);
  head.write(command, 4, 'ascii');                       // zero-padded to 12 bytes by Buffer.alloc
  head.writeUInt32LE(payload.length, 16);
  sha256d(payload).copy(head, 20, 0, 4);
  return Buffer.concat([head, payload]);
}

// ---------- header-chain rules (must match contracts/src/BitcoinRelay.sol) ----------
export function targetOf(bits) {
  const size = bits >>> 24, word = BigInt(bits & 0x007fffff);
  if (word === 0n || (bits & 0x00800000) !== 0) throw Error('target sign/zero');
  const target = size <= 3 ? word >> BigInt(8 * (3 - size)) : word << BigInt(8 * (size - 3));
  if (target === 0n || target > POW_LIMIT) throw Error('target range');
  return target;
}
export function compact(target) {
  let size = 0; for (let t = target; t > 0n; t >>= 8n) size++;
  let word = size <= 3 ? target << BigInt(8 * (3 - size)) : target >> BigInt(8 * (size - 3));
  if (word & 0x00800000n) { word >>= 8n; size++; }
  return Number(word | (BigInt(size) << 24n));
}
export function retarget(bits, first, last) {
  let elapsed = last - first;
  if (elapsed < TARGET_TIMESPAN / 4) elapsed = TARGET_TIMESPAN / 4;
  if (elapsed > TARGET_TIMESPAN * 4) elapsed = TARGET_TIMESPAN * 4;
  const next = (targetOf(bits) * BigInt(elapsed)) / BigInt(TARGET_TIMESPAN);
  return compact(next > POW_LIMIT ? POW_LIMIT : next);
}
const workOf = target => (((1n << 256n) - target - 1n) / (target + 1n)) + 1n;
const hashValue = internal => BigInt('0x' + Buffer.from(internal).reverse().toString('hex'));

/// Apply one `headers` reply. A reply that extends the tip is appended. A reply that forks below the tip is
/// validated on a copy, extended through `more(locator)` while it is still lighter, and adopted only if it then
/// has more cumulative work than this chain: a peer on a lighter or invalid branch can no longer make us drop
/// validated headers (2026-10-01: a minority branch from 961632 made every keeper rewind ~8,200 headers,
/// fail at 961640 and re-download them, hundreds of times a day). Throws on an invalid header; for a fork,
/// this chain is untouched when it does. Returns { added, last } (`last`: length of the last reply).
export async function applyHeaders(chain, batch, more, log = () => {}) {
  const parent = Buffer.from(batch[0].subarray(4, 36)).reverse().toString('hex');
  if (chain.hashes[chain.height] === parent) {
    for (const raw of batch) chain.append(raw);
    return { added: batch.length, last: batch.length };
  }
  const at = chain.hashes.lastIndexOf(parent);
  if (at < 0) return { added: 0, last: batch.length };            // an unrelated branch: nothing to compare
  const candidate = chain.fork(at);
  let reply = batch;
  for (;;) {
    for (const raw of reply) candidate.append(raw);
    if (candidate.work > chain.work || reply.length < MAX_HEADERS) break;
    reply = await more(candidate.locator());
    if (!reply.length) break;
  }
  if (candidate.work <= chain.work) {
    if (candidate.height < chain.height || candidate.hashes[chain.height] !== chain.hashes[chain.height]) {
      log(`headers: ignored a branch from ${at} with less work (to ${candidate.height})`);
    }
    return { added: 0, last: reply.length };
  }
  const before = chain.height;
  const forked = candidate.hashes[Math.min(before, candidate.height)] !== chain.hashes[Math.min(before, candidate.height)];
  if (forked) log(`headers: reorg at ${at}, ${before} → ${candidate.height} (more work)`);
  chain.adopt(candidate);
  return { added: Math.max(1, chain.height - before), last: reply.length };
}

/// In-memory header chain, validated from the Bitcoin genesis block.
export class HeaderChain {
  constructor() {
    this.headers = [];      // Buffer(80) per height
    this.hashes = [];       // 'hex' display hash per height
    this.work = 0n;
    this.epochStart = 0;    // timestamp of the first block of the current 2016-block epoch
  }
  get height() { return this.headers.length - 1; }
  /// Append one header at `this.height + 1`, applying every consensus rule we can check from headers alone.
  append(raw) {
    if (raw.length !== 80) throw Error('header must be 80 bytes');
    const height = this.headers.length;
    const bits = raw.readUInt32LE(72), time = raw.readUInt32LE(68);
    const internal = sha256d(raw);
    if (height === 0) {
      if (Buffer.from(internal).reverse().toString('hex') !== GENESIS_HASH) throw Error('wrong genesis');
      this.epochStart = time;
    } else {
      const parent = raw.subarray(4, 36).toString('hex');
      if (parent !== sha256d(this.headers[height - 1]).toString('hex')) throw Error(`linkage at ${height}`);
      const parentBits = this.headers[height - 1].readUInt32LE(72);
      const expected = height % RETARGET === 0
        ? retarget(parentBits, this.epochStart, this.headers[height - 1].readUInt32LE(68))
        : parentBits;
      if (bits !== expected) throw Error(`difficulty at ${height}`);
      if (height % RETARGET === 0) this.epochStart = time;
    }
    const target = targetOf(bits);
    if (hashValue(internal) > target) throw Error(`PoW at ${height}`);
    this.headers.push(raw);
    this.hashes.push(Buffer.from(internal).reverse().toString('hex'));
    this.work += workOf(target);
    return height;
  }
  headerWork(raw) { return workOf(targetOf(raw.readUInt32LE(72))); }
  /// A copy truncated at `height`, for validating a competing branch without touching this chain.
  fork(height) {
    const c = Object.create(Object.getPrototypeOf(this));
    c.headers = this.headers.slice(0, height + 1);
    c.hashes = this.hashes.slice(0, height + 1);
    c.rewind(height);
    return c;
  }
  /// Take over a validated branch built with `fork`.
  adopt(other) {
    this.headers = other.headers; this.hashes = other.hashes; this.work = other.work; this.epochStart = other.epochStart;
  }
  /// Drop everything above `height` so a heavier branch can replace it.
  rewind(height) {
    while (this.height > height) { this.headers.pop(); this.hashes.pop(); }
    this.work = 0n;
    for (const h of this.headers) this.work += this.headerWork(h);
    const epoch = Math.floor(this.headers.length ? (this.headers.length - 1) / RETARGET : 0) * RETARGET;
    this.epochStart = this.headers[epoch]?.readUInt32LE(68) ?? 0;
  }
  /// Block locator: dense near the tip, then exponential back — the standard `getheaders` form.
  locator() {
    const out = [];
    for (let i = this.height, stride = 1; i >= 0; i -= stride) {
      out.push(Buffer.from(this.hashes[i], 'hex').reverse());
      if (out.length > 10) stride *= 2;
    }
    if (this.height >= 0 && out.at(-1).toString('hex') !== Buffer.from(this.hashes[0], 'hex').reverse().toString('hex')) {
      out.push(Buffer.from(this.hashes[0], 'hex').reverse());
    }
    return out;
  }
  save(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', Buffer.concat(this.headers));
    fs.renameSync(file + '.tmp', file);
  }
  load(file) {
    if (!fs.existsSync(file)) return 0;
    const buf = fs.readFileSync(file);
    for (let o = 0; o + 80 <= buf.length; o += 80) {
      try { this.append(buf.subarray(o, o + 80)); } catch { break; }   // stop at the first bad/partial header
    }
    return this.headers.length;
  }
}

/// One peer connection that answers `getheaders` until the chain stops growing.
class Peer {
  constructor(host, port = PORT, { timeout = 20000 } = {}) {
    this.host = host; this.port = port; this.timeout = timeout;
    this.buffer = Buffer.alloc(0); this.waiters = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port, timeout: this.timeout });
      const fail = e => { this.socket.destroy(); reject(e instanceof Error ? e : Error('peer timeout')); };
      this.socket.once('error', fail);
      this.socket.once('timeout', fail);
      this.socket.on('data', chunk => this._consume(chunk));
      this.socket.once('connect', () => { this.socket.setTimeout(this.timeout); resolve(); });
    });
  }
  _consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 24) return;
      if (this.buffer.readUInt32LE(0) !== MAGIC) { this.buffer = this.buffer.subarray(1); continue; }
      const length = this.buffer.readUInt32LE(16);
      if (length > 32 * 1024 * 1024) { this.socket.destroy(); return; }
      if (this.buffer.length < 24 + length) return;
      const command = this.buffer.subarray(4, 16).toString('ascii').replace(/\0+$/, '');
      const payload = this.buffer.subarray(24, 24 + length);
      if (!sha256d(payload).subarray(0, 4).equals(this.buffer.subarray(20, 24))) { this.socket.destroy(); return; }
      this.buffer = this.buffer.subarray(24 + length);
      if (command === 'ping') this.send('pong', Buffer.from(payload));
      const waiter = this.waiters.get(command);
      if (waiter) { this.waiters.delete(command); waiter(Buffer.from(payload)); }
    }
  }
  send(command, payload) { this.socket.write(frame(command, payload)); }
  expect(command, timeout = this.timeout) {
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(command); reject(Error(`no ${command} from peer`)); }, timeout);
      this.waiters.set(command, payload => { clearTimeout(timer); resolve(payload); });
    });
    // A handshake creates the `verack` waiter before awaiting `version`; if `version` times out first,
    // nothing ever awaits `verack` and its rejection would take the whole process down. Mark it handled
    // here — callers that do await still see the rejection.
    pending.catch(() => {});
    return pending;
  }
  async handshake(startHeight = 0) {
    const p = Buffer.alloc(86);
    p.writeInt32LE(PROTOCOL, 0);
    p.writeBigUInt64LE(0n, 4);                                   // services: none, we are a light client
    p.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 12);
    // addr_recv (26) and addr_from (26) may be zero; peers do not rely on them for headers.
    Buffer.from('0000000000000000', 'hex').copy(p, 72);          // nonce
    const ua = Buffer.from('/wuji-headers:0.1/', 'ascii');
    const tail = Buffer.concat([varint(ua.length), ua, Buffer.alloc(4), Buffer.from([0])]);
    tail.writeUInt32LE(startHeight, 1 + ua.length);
    const version = Buffer.concat([p.subarray(0, 80), tail]);
    const theirVersion = this.expect('version');
    const theirVerack = this.expect('verack');
    this.send('version', version);
    await theirVersion;
    this.send('verack', Buffer.alloc(0));
    // Bitcoin Core discards everything received before it has sent its own verack, so a getheaders
    // issued straight after their version is silently dropped. Wait for the handshake to complete.
    await theirVerack;
    this.send('sendheaders', Buffer.alloc(0));
  }
  async getheaders(locator) {
    const payload = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(PROTOCOL, 0); return b; })(),
      varint(locator.length), ...locator, Buffer.alloc(32),
    ]);
    const answer = this.expect('headers');
    this.send('getheaders', payload);
    const body = await answer;
    const [count, start] = readVarint(body, 0);
    const out = [];
    let o = start;
    for (let i = 0; i < count; i++) {
      out.push(Buffer.from(body.subarray(o, o + 80)));
      const [, next] = readVarint(body, o + 80);                  // tx_count, always 0 in a headers message
      o = next;
    }
    return out;
  }
  close() { this.socket?.destroy(); }
}

/// Drop-in replacement for BitcoinAPI backed by the P2P network.
export class BitcoinP2P {
  constructor({ peers, dir, log = () => {}, peerTimeout } = {}) {
    this.peerTimeout = peerTimeout ?? +(process.env.BITCOIN_P2P_TIMEOUT_MS || 20000);
    this.configured = peers ?? (process.env.BITCOIN_P2P_PEERS || '').split(',').map(s => s.trim()).filter(Boolean);
    this.file = path.join(dir ?? process.env.BITCOIN_P2P_DIR ?? 'indexer/data/headers', 'mainnet.bin');
    this.chain = new HeaderChain();
    this.log = log;
    this.syncing = null;
    this.lastSync = 0;
  }
  async peerList() {
    if (this.configured.length) return this.configured.map(p => { const [h, port] = p.split(':'); return [h, +(port || PORT)]; });
    const found = [];
    for (const seed of SEEDS) {
      try { for (const a of await dns.resolve4(seed)) found.push([a, PORT]); } catch { /* seed down: try the next */ }
      if (found.length >= 12) break;
    }
    if (!found.length) throw Error('no Bitcoin peers found (DNS seeds unreachable)');
    return found.sort(() => Math.random() - 0.5);
  }
  /// Extend the chain from the network. Returns the new height. Safe to call concurrently.
  async sync({ force = false, maxAgeMs = 20000 } = {}) {
    if (this.syncing) return this.syncing;
    if (!force && Date.now() - this.lastSync < maxAgeMs && this.chain.height > 0) return this.chain.height;
    this.syncing = this._sync().finally(() => { this.syncing = null; this.lastSync = Date.now(); });
    return this.syncing;
  }
  async _sync() {
    if (!this.chain.headers.length) {
      const loaded = this.chain.load(this.file);
      if (loaded) this.log(`headers: loaded ${loaded} from disk (tip ${this.chain.height})`);
      else this.chain.append(GENESIS_HEADER);
    }
    let lastError;
    for (const [host, port] of await this.peerList()) {
      const peer = new Peer(host, port, { timeout: this.peerTimeout });
      try {
        await peer.connect();
        await peer.handshake(Math.max(0, this.chain.height));
        const before = this.chain.height;
        for (;;) {
          const batch = await peer.getheaders(this.chain.locator());
          if (!batch.length) break;
          const { added, last } = await applyHeaders(this.chain, batch, loc => peer.getheaders(loc), this.log);
          if (!added) break;
          if (this.chain.height - before > 50000) this.log(`headers: ${this.chain.height}`);
          if (last < MAX_HEADERS) break;
        }
        peer.close();
        if (this.chain.height > before || this.chain.height > 0) {
          if (this.chain.height > before) this.chain.save(this.file);
          if (this.chain.height > before) this.log(`headers: tip ${this.chain.height} (+${this.chain.height - before}) via ${host}`);
          return this.chain.height;
        }
      } catch (e) {
        lastError = e; peer.close();
        this.log(`peer ${host}: ${e.message}`);
      }
    }
    if (this.chain.height > 0) return this.chain.height;             // keep serving what we validated earlier
    throw lastError ?? Error('no peer returned headers');
  }
  // ---------- BitcoinAPI-compatible surface ----------
  async tip() { return this.sync(); }
  async hashAt(height) {
    if (height > this.chain.height) await this.sync({ force: true });
    const hash = this.chain.hashes[height];
    if (!hash) throw Error(`height ${height} above validated tip ${this.chain.height}`);
    return hash;
  }
  async at(height) {
    const hash = await this.hashAt(height);
    return { height, hash, header: this.chain.headers[height].toString('hex') };
  }
  async header(hash) {
    const at = this.chain.hashes.indexOf(hash);
    if (at < 0) throw Error('unknown header');
    return this.chain.headers[at].toString('hex');
  }
  get host() { return 'p2p'; }
}

export const describe = () => 'bitcoin p2p headers';
export { step };
