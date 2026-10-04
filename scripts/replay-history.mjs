#!/usr/bin/env node
// Full-history replay, step 1: split a raw Bitcoin mainnet header file (80-byte headers from height 0, as the
// P2P keeper stores them) into SEGMENTS independent pieces for contracts/test/FullHistoryReplay.t.sol, and
// compute what the contract must end each piece with, independently of the contract: U = Σ(byteSum − 4080),
// the summed work, and the tip hash. Linkage and proof of work are checked here too, so a corrupt file fails
// before the contract sees it.
//
//   node scripts/replay-history.mjs [headers.bin]       # default indexer/data/headers-sepolia/mainnet.bin
//   cd contracts && WUJI_REPLAY_DIR=cache/replay forge test --match-contract FullHistoryReplay --gas-limit 18446744073709551615
import fs from 'node:fs';
import path from 'node:path';
import { sha256, sha256d } from '../indexer/bitcoin.mjs';

const SEGMENTS = 24;          // must equal FullHistoryReplayTest.SEGMENTS
const FIRST_ANCHOR = 10;      // the contract needs the 11 timestamps ending at its anchor: heights 0..10
const K = 100;                // CONFIRMATIONS
const GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const file = process.argv[2] || path.join(root, 'indexer/data/headers-sepolia/mainnet.bin');
const out = path.join(root, 'contracts/cache/replay');

const buf = fs.readFileSync(file);
if (buf.length % 80) throw Error('file is not a whole number of 80-byte headers');
const n = buf.length / 80;
const header = h => buf.subarray(h * 80, h * 80 + 80);
const time = h => buf.readUInt32LE(h * 80 + 68);
const target = bits => {
  const exp = bits >>> 24, mant = BigInt(bits & 0x7fffff);
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
};
const work = bits => (1n << 256n) / (target(bits) + 1n);

// Pass 1: the file is one linked chain with valid proof of work, starting at the real genesis block.
const hashes = new Array(n);
const delta = new Int32Array(n);
const works = new Array(n);
for (let h = 0; h < n; h++) {
  const raw = header(h), d = sha256d(raw);
  if (h === 0 && Buffer.from(d).reverse().toString('hex') !== GENESIS) throw Error('height 0 is not the Bitcoin genesis block');
  if (h > 0 && !raw.subarray(4, 36).equals(hashes[h - 1])) throw Error(`header ${h} does not link to ${h - 1}`);
  const bits = raw.readUInt32LE(72);
  if (BigInt('0x' + Buffer.from(d).reverse().toString('hex')) > target(bits)) throw Error(`header ${h} fails proof of work`);
  hashes[h] = d;
  delta[h] = [...sha256(d)].reduce((a, b) => a + b, 0) - 4080;
  works[h] = work(bits);
}
const tip = n - 1, end = tip - K;
console.log(`${n} headers, tip ${tip} ${Buffer.from(hashes[tip]).reverse().toString('hex')}`);
console.log(`replaying heights ${FIRST_ANCHOR + 1}..${end} in ${SEGMENTS} segments`);

// Pass 2: segments. Segment i is anchored at b[i] and must fold exactly to b[i+1].
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const b = Array.from({ length: SEGMENTS + 1 }, (_, i) => FIRST_ANCHOR + Math.round(i * (end - FIRST_ANCHOR) / SEGMENTS));
let totalU = 0, totalWork = 0n;
for (let i = 0; i < SEGMENTS; i++) {
  const a = b[i], e = b[i + 1];
  let u = 0, w = 0n;
  for (let h = a + 1; h <= e; h++) { u += delta[h]; w += works[h]; }
  totalU += u; totalWork += w;
  fs.writeFileSync(path.join(out, `seg-${i}.bin`), buf.subarray(a * 80, (e + K + 1) * 80));
  fs.writeFileSync(path.join(out, `seg-${i}.json`), JSON.stringify({
    anchorHeight: a,
    endHeight: e,
    epochStart: time(a - (a % 2016)),
    ancestorTimes: Array.from({ length: 11 }, (_, k) => time(a - 10 + k)),
    now: time(tip) + 1,
    expectedU: u,
    expectedWork: '0x' + w.toString(16).padStart(64, '0'),
    endHash: '0x' + Buffer.from(hashes[e]).toString('hex'),
  }, null, 1) + '\n');
}
const summary = { headers: n, tip, tipHash: Buffer.from(hashes[tip]).reverse().toString('hex'), from: FIRST_ANCHOR + 1, to: end,
  segments: SEGMENTS, totalU, totalWork: '0x' + totalWork.toString(16) };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(JSON.stringify(summary));
