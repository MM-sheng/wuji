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
const CONTRACT = process.env.CONTRACT || '';   // WujiIndex address on the chain RPC points at; enables the on-chain cross-check
const VAULT = process.env.VAULT || '';
const UNIT = 3.3e-7;           // log-increment per unit of (byteSum − 4080); contract: UNIT = 3.3e11 wad
const MEAN = 4080;             // 32 · 127.5
const SIGMA = UNIT * Math.sqrt(32 * 65535 / 12);  // ≈1.38e-4 per block (≈6%/day at ~192k blocks/day)
const CONFIRM = 8;             // stay this many blocks behind head (reorg safety)
const BATCH = 100;             // blocks per JSON-RPC batch
const PAR = 6;                 // parallel batches while catching up
const REC = 12;                // bytes per stored block: f64 U (exact integer Σ(byteSum−4080)), u32 ts
const STATIC_DIR = path.join(__dirname, '..', 'apps', 'terminal');

fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, `blocks-v2-${GENESIS_BLOCK}.bin`);

// ---------- deterministic increment from a block hash (see docs/ARCHITECTURE.md §1, contracts/src/WujiIndex.sol) ----------
// byteSum: sum of the 32 bytes of the hash. Integer, exact, identical to the contract's SWAR byteSum().
export function byteSum(hash) {
  const h = hash.startsWith('0x') ? hash.slice(2) : hash; let s = 0;
  for (let i = 0; i < 64; i += 2) s += parseInt(h.slice(i, i + 2), 16);
  return s;
}
// U accumulates the exact integer Σ(byteSum − MEAN); S = U · UNIT. Float64 holds U exactly for millennia.
const S_of = u => u * UNIT;

// ---------- storage (typed arrays, append-only file) ----------
let cap = 1 << 20, n = 0;
let U = new Float64Array(cap), TS = new Uint32Array(cap);
let lastHash = null;           // hash of block GENESIS_BLOCK+n-1, for parent linkage
function grow() { cap *= 2; const u = new Float64Array(cap), t = new Uint32Array(cap); u.set(U); t.set(TS); U = u; TS = t; }
function push(u, ts) { if (n === cap) grow(); U[n] = u; TS[n] = ts; n++; }

function loadFile() {
  if (!fs.existsSync(FILE)) return;
  const buf = fs.readFileSync(FILE); const cnt = Math.floor(buf.length / REC);
  for (let i = 0; i < cnt; i++) { const o = i * REC; push(buf.readDoubleLE(o), buf.readUInt32LE(o + 8)); }
  const meta = path.join(DATA_DIR, `meta-${GENESIS_BLOCK}.json`);
  if (fs.existsSync(meta)) lastHash = JSON.parse(fs.readFileSync(meta, 'utf8')).lastHash;
  console.log(`loaded ${n} blocks from disk (up to #${GENESIS_BLOCK + n - 1})`);
}
let pending = [];
function persist() {
  if (!pending.length) return;
  const buf = Buffer.alloc(pending.length * REC);
  pending.forEach((i, k) => { const o = k * REC; buf.writeDoubleLE(U[i], o); buf.writeUInt32LE(TS[i], o + 8); });
  fs.appendFileSync(FILE, buf); pending = [];
  fs.writeFileSync(path.join(DATA_DIR, `meta-${GENESIS_BLOCK}.json`), JSON.stringify({ lastHash, n }));
}
function truncate(to) { // reorg: drop blocks >= to (index), rewrite file
  n = to; lastHash = null; pending = [];
  const buf = Buffer.alloc(n * REC);
  for (let i = 0; i < n; i++) { const o = i * REC; buf.writeDoubleLE(U[i], o); buf.writeUInt32LE(TS[i], o + 8); }
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

// ---------- on-chain cross-check (raw eth_call, no ABI library) ----------
const SEL = { S: '0x4be1c796', lastBlock: '0x806b984f', frozenBlocks: '0x6998a0d0', yangShare: '0xdbc1faef', currentId: '0xe00dd161', series: '0xdc22cb6a' };
const call = async (to, data) => (await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })).result;
const toInt = h => { const v = BigInt(h); return v >= (1n << 255n) ? v - (1n << 256n) : v; };
let chain = null;
async function pollChain() {
  if (!CONTRACT) return;
  try {
    const [sW, lb, fz] = await Promise.all([call(CONTRACT, SEL.S), call(CONTRACT, SEL.lastBlock), call(CONTRACT, SEL.frozenBlocks)]);
    const c = { contract: CONTRACT, S_wad: toInt(sW).toString(), lastBlock: Number(BigInt(lb)), frozenBlocks: Number(BigInt(fz)) };
    // what the indexer says S should be at the contract's lastBlock (exact integer U · 3.3e11)
    const i = c.lastBlock - GENESIS_BLOCK;
    if (i >= 0 && i < n) { c.indexer_S_wad = (BigInt(U[i]) * 330000000000n).toString(); c.agree = c.indexer_S_wad === c.S_wad || c.frozenBlocks > 0; }
    c.S = Number(toInt(sW)) / 1e18; c.price = 100 * Math.exp(c.S);
    if (VAULT) {
      const [ys, cid] = await Promise.all([call(VAULT, SEL.yangShare), call(VAULT, SEL.currentId)]);
      const id = Number(BigInt(cid));
      const sr = await call(VAULT, SEL.series + id.toString(16).padStart(64, '0'));
      const w = k => '0x' + sr.slice(2 + 64 * k, 2 + 64 * (k + 1));
      c.vault = { address: VAULT, seriesId: id, yang: '0x' + w(0).slice(26), yin: '0x' + w(1).slice(26), s0_wad: toInt(w(2)).toString(), start: Number(BigInt(w(3))), expiry: Number(BigInt(w(4))), settled: BigInt(w(5)) !== 0n, yangShare: Number(BigInt(ys)) / 1e18 };
    }
    chain = c;
  } catch (e) { chain = { contract: CONTRACT, err: e.message }; }
}
(async () => { for (;;) { await pollChain(); await sleep(3000); } })();

// ---------- sync loop ----------
let head = 0, syncing = true, lastErr = null;
async function syncOnce() {
  head = await headNumber();
  const target = head - CONFIRM;
  while (GENESIS_BLOCK + n <= target) {
    const from = GENESIS_BLOCK + n;
    const ranges = []; for (let a = from, k = 0; a <= target && k < PAR; a += BATCH, k++) ranges.push([a, Math.min(target, a + BATCH - 1)]);
    const batches = await Promise.all(ranges.map(([a, b]) => getBlocks(a, b)));
    for (const b of batches.flat()) {
      if (lastHash && b.parentHash !== lastHash) {           // reorg: rewind 64 blocks and retry
        console.warn(`reorg at #${GENESIS_BLOCK + n}: rewinding`); truncate(Math.max(0, n - 64)); return;
      }
      push((n ? U[n - 1] : 0) + (byteSum(b.hash) - MEAN), parseInt(b.timestamp, 16));
      pending.push(n - 1); lastHash = b.hash;
    }
    persist();
    if (ranges.length > 1) console.log(`synced to #${GENESIS_BLOCK + n - 1}  (${target - (GENESIS_BLOCK + n - 1)} behind)`);
  }
  syncing = false;
}
async function loop() { for (;;) { try { await syncOnce(); lastErr = null; } catch (e) { lastErr = e.message; console.error('sync:', e.message); } await sleep(syncing ? 50 : 400); } }

// ---------- queries ----------
const priceAt = i => 100 * Math.exp(S_of(U[i]));
const yangAt = (i, i0) => Math.min(100, Math.max(0, 50 + 50 * S_of(U[i] - (i0 ? U[i0 - 1] : 0))));
function idxAtTs(ts) { // last block index with TS <= ts, or -1
  let lo = 0, hi = n - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (TS[m] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; } return ans;
}
function headInfo() {
  const i = n - 1; if (i < 0) return { synced: false, blocks: 0, genesisBlock: GENESIS_BLOCK };
  return { block: GENESIS_BLOCK + i, ts: TS[i], U: U[i], S: S_of(U[i]), price: priceAt(i), yang: yangAt(i, 0), genesisBlock: GENESIS_BLOCK, genesisTs: TS[0], blocks: n, chainHead: head, behind: head - (GENESIS_BLOCK + i), synced: !syncing, unit: UNIT, sigma: SIGMA, err: lastErr, chain };
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
  const blk = await getBlock(b); const bs = byteSum(blk.hash), d = bs - MEAN, uPrev = i ? U[i - 1] : 0;
  return { block: b, hash: blk.hash, parentHash: blk.parentHash, timestamp: parseInt(blk.timestamp, 16),
    byteSum: bs, delta: d, U_prev: uPrev, U: U[i], U_check: uPrev + d, consistent: uPrev + d === U[i],
    unit: UNIT, r: d * UNIT, S: S_of(U[i]), S_wad: (BigInt(U[i]) * 330000000000n).toString(), price: priceAt(i), yang: yangAt(i, 0),
    bscscan: `https://bscscan.com/block/${b}`, contract: 'WujiIndex.increment(hash) == (byteSum(hash) − 4080) · 3.3e11 wad; S = Σ increment',
    method: 'byteSum = Σ of the 32 bytes of blockhash; U = Σ(byteSum − 4080); S = U · 3.3e-7; price = 100·e^S' };
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
      const out = []; for (let b = from; b <= to; b++) { const i = b - GENESIS_BLOCK; out.push([b, TS[i], U[i], S_of(U[i])]); }
      return json({ columns: ['block', 'ts', 'U', 'S'], rows: out });
    }
    if (u.pathname === '/blockAt') { // which block is "current" at a given unix second
      const i = idxAtTs(+q.get('ts')); return i < 0 ? json({ error: 'before genesis' }, 404) : json({ block: GENESIS_BLOCK + i, ts: TS[i], U: U[i], S: S_of(U[i]), price: priceAt(i) });
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
  server.listen(PORT, () => console.log(`wuji indexer  http://localhost:${PORT}  genesis #${GENESIS_BLOCK}  unit=${UNIT} σ≈${SIGMA.toExponential(3)}`));
  loop();
}
