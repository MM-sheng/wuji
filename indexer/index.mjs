// WUJI indexer — follows BSC, turns block hashes into the index, serves it over HTTP.
// No authority: anyone can recompute everything from a public RPC. This is a cache.
//
//   node indexer/index.mjs            (env: RPC, PORT, DATA_DIR, GENESIS_BLOCK)
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPCS = (process.env.RPC || 'https://bsc-dataseed.binance.org,https://bsc-dataseed1.defibit.io,https://bsc-dataseed1.ninicoin.io').split(',');
const PORT = +(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GENESIS_BLOCK = +(process.env.GENESIS_BLOCK || 122616000);
const SIGMA = 1.4e-4;          // per-block log vol  (≈6%/day at ~192k blocks/day)
const CONFIRM = 8;             // stay this many blocks behind head (reorg safety)
const BATCH = 100;             // blocks per JSON-RPC batch
const REC = 20;                // bytes per stored block: f64 S, f64 A, u32 ts
const STATIC_DIR = path.join(__dirname, '..', 'apps', 'terminal');

fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, `blocks-${GENESIS_BLOCK}.bin`);

// ---------- deterministic increment from a block hash (see docs/ARCHITECTURE.md §1) ----------
export function zFromHash(hash) {
  const h = hash.startsWith('0x') ? hash.slice(2) : hash;
  const u1 = Math.max(Number(BigInt('0x' + h.slice(0, 16))) / 2 ** 64, 2 ** -53);
  const u2 = Number(BigInt('0x' + h.slice(16, 32))) / 2 ** 64;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------- storage (typed arrays, append-only file) ----------
let cap = 1 << 20, n = 0;
let S = new Float64Array(cap), A = new Float64Array(cap), TS = new Uint32Array(cap);
let lastHash = null;           // hash of block GENESIS_BLOCK+n-1, for parent linkage
function grow() { cap *= 2; const s = new Float64Array(cap), a = new Float64Array(cap), t = new Uint32Array(cap); s.set(S); a.set(A); t.set(TS); S = s; A = a; TS = t; }
function push(s, a, ts) { if (n === cap) grow(); S[n] = s; A[n] = a; TS[n] = ts; n++; }

function loadFile() {
  if (!fs.existsSync(FILE)) return;
  const buf = fs.readFileSync(FILE); const cnt = Math.floor(buf.length / REC);
  for (let i = 0; i < cnt; i++) { const o = i * REC; push(buf.readDoubleLE(o), buf.readDoubleLE(o + 8), buf.readUInt32LE(o + 16)); }
  const meta = path.join(DATA_DIR, `meta-${GENESIS_BLOCK}.json`);
  if (fs.existsSync(meta)) lastHash = JSON.parse(fs.readFileSync(meta, 'utf8')).lastHash;
  console.log(`loaded ${n} blocks from disk (up to #${GENESIS_BLOCK + n - 1})`);
}
let pending = [];
function persist() {
  if (!pending.length) return;
  const buf = Buffer.alloc(pending.length * REC);
  pending.forEach((i, k) => { const o = k * REC; buf.writeDoubleLE(S[i], o); buf.writeDoubleLE(A[i], o + 8); buf.writeUInt32LE(TS[i], o + 16); });
  fs.appendFileSync(FILE, buf); pending = [];
  fs.writeFileSync(path.join(DATA_DIR, `meta-${GENESIS_BLOCK}.json`), JSON.stringify({ lastHash, n }));
}
function truncate(to) { // reorg: drop blocks >= to (index), rewrite file
  n = to; lastHash = null; pending = [];
  const buf = Buffer.alloc(n * REC);
  for (let i = 0; i < n; i++) { const o = i * REC; buf.writeDoubleLE(S[i], o); buf.writeDoubleLE(A[i], o + 8); buf.writeUInt32LE(TS[i], o + 16); }
  fs.writeFileSync(FILE, buf);
}

// ---------- RPC ----------
let rpcIdx = 0;
async function rpc(body) {
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const url = RPCS[rpcIdx % RPCS.length];
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error('http ' + res.status);
      const j = await res.json();
      if (!Array.isArray(body) && j.error) throw new Error(j.error.message);
      return j;
    } catch (e) { console.warn(`rpc ${url}: ${e.message}`); rpcIdx++; await sleep(500); }
  }
  throw new Error('all RPCs failed');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = x => '0x' + x.toString(16);
async function headNumber() { return parseInt((await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })).result, 16); }
async function getBlocks(from, to) {
  const req = []; for (let b = from; b <= to; b++) req.push({ jsonrpc: '2.0', id: b, method: 'eth_getBlockByNumber', params: [hex(b), false] });
  const j = await rpc(req); const map = new Map(j.forEach ? j.map(x => [x.id, x.result]) : []);
  const out = []; for (let b = from; b <= to; b++) { const r = map.get(b); if (!r) throw new Error('missing block ' + b); out.push(r); }
  return out;
}
async function getBlock(b) { return (await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [hex(b), false] })).result; }

// ---------- sync loop ----------
let head = 0, syncing = true, lastErr = null;
async function syncOnce() {
  head = await headNumber();
  const target = head - CONFIRM;
  while (GENESIS_BLOCK + n <= target) {
    const from = GENESIS_BLOCK + n, to = Math.min(target, from + BATCH - 1);
    const blocks = await getBlocks(from, to);
    for (const b of blocks) {
      if (lastHash && b.parentHash !== lastHash) {           // reorg: rewind 64 blocks and retry
        console.warn(`reorg at #${from}: rewinding`); truncate(Math.max(0, n - 64)); return;
      }
      const z = zFromHash(b.hash), r = SIGMA * z;
      const prevS = n ? S[n - 1] : 0, prevA = n ? A[n - 1] : 0;
      push(prevS + r, prevA + (Math.exp(r) - 1), parseInt(b.timestamp, 16));
      pending.push(n - 1); lastHash = b.hash;
    }
    persist();
    if (blocks.length >= BATCH) console.log(`synced to #${GENESIS_BLOCK + n - 1}  (${target - (GENESIS_BLOCK + n - 1)} behind)`);
  }
  syncing = false;
}
async function loop() { for (;;) { try { await syncOnce(); lastErr = null; } catch (e) { lastErr = e.message; console.error('sync:', e.message); } await sleep(syncing ? 50 : 400); } }

// ---------- queries ----------
const priceAt = i => 100 * Math.exp(S[i]);
function idxAtTs(ts) { // last block index with TS <= ts, or -1
  let lo = 0, hi = n - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (TS[m] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; } return ans;
}
function headInfo() {
  const i = n - 1; if (i < 0) return { synced: false, blocks: 0, genesisBlock: GENESIS_BLOCK };
  return { block: GENESIS_BLOCK + i, ts: TS[i], S: S[i], A: A[i], price: priceAt(i), yang: Math.min(100, Math.max(0, 50 + 50 * A[i])), genesisBlock: GENESIS_BLOCK, genesisTs: TS[0], blocks: n, chainHead: head, behind: head - (GENESIS_BLOCK + i), synced: !syncing, sigma: SIGMA, err: lastErr };
}
// per-second closing prices, Float32 buffer, seconds [from, to]
function seconds(from, to) {
  const len = Math.max(0, to - from + 1); const out = new Float32Array(len);
  let i = idxAtTs(from); if (i < 0) i = 0;
  for (let k = 0; k < len; k++) { const ts = from + k; while (i + 1 < n && TS[i + 1] <= ts) i++; out[k] = priceAt(i); }
  return out;
}
async function proof(b) {
  const i = b - GENESIS_BLOCK; if (i < 0 || i >= n) return { error: 'block not indexed' };
  const blk = await getBlock(b); const z = zFromHash(blk.hash), r = SIGMA * z;
  return { block: b, hash: blk.hash, parentHash: blk.parentHash, timestamp: parseInt(blk.timestamp, 16), sigma: SIGMA, z, r, S_prev: i ? S[i - 1] : 0, S: S[i], S_check: (i ? S[i - 1] : 0) + r, price: priceAt(i), A: A[i], yang: Math.min(100, Math.max(0, 50 + 50 * A[i])), bscscan: `https://bscscan.com/block/${b}`, method: 'u1=hash[0:8]/2^64, u2=hash[8:16]/2^64, Z=sqrt(-2 ln u1)cos(2π u2), r=σZ, S=ΣR, price=100·e^S' };
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const q = u.searchParams;
  res.setHeader('access-control-allow-origin', '*'); res.setHeader('cache-control', 'no-store');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === '/head') return json(headInfo());
    if (u.pathname === '/seconds') {
      if (!n) return json({ error: 'not synced' }, 503);
      const from = Math.max(TS[0], +q.get('from') || TS[0]), to = Math.min(TS[n - 1], +q.get('to') || TS[n - 1]);
      if (to - from > 7 * 86400) return json({ error: 'max 7 days per request' }, 400);
      const buf = seconds(from, to);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-from': from, 'x-to': to, 'x-head-block': GENESIS_BLOCK + n - 1, 'access-control-expose-headers': 'x-from,x-to,x-head-block' });
      return res.end(Buffer.from(buf.buffer));
    }
    if (u.pathname === '/blocks') {
      const from = Math.max(GENESIS_BLOCK, +q.get('from') || GENESIS_BLOCK), to = Math.min(GENESIS_BLOCK + n - 1, +q.get('to') || from + 999, from + 4999);
      const out = []; for (let b = from; b <= to; b++) { const i = b - GENESIS_BLOCK; out.push([b, TS[i], S[i], A[i]]); }
      return json({ columns: ['block', 'ts', 'S', 'A'], rows: out });
    }
    if (u.pathname === '/blockAt') { // which block is "current" at a given unix second
      const i = idxAtTs(+q.get('ts')); return i < 0 ? json({ error: 'before genesis' }, 404) : json({ block: GENESIS_BLOCK + i, ts: TS[i], S: S[i], price: priceAt(i) });
    }
    const m = u.pathname.match(/^\/proof\/(\d+)$/); if (m) return json(await proof(+m[1]));
    // static terminal
    let p = u.pathname === '/' ? '/index.html' : u.pathname; const f = path.join(STATIC_DIR, path.normalize(p));
    if (f.startsWith(STATIC_DIR) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
    json({ error: 'not found' }, 404);
  } catch (e) { json({ error: e.message }, 500); }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadFile();
  server.listen(PORT, () => console.log(`wuji indexer  http://localhost:${PORT}  genesis #${GENESIS_BLOCK}  σ=${SIGMA}`));
  loop();
}
