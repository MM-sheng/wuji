// Test helpers shared by the ZK Node tests: the committed mainnet fixture, the Rust journal decoder and
// ABI encoders mirroring ZkWujiIndex's views. Not used by any running process.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixture = f => fs.readFileSync(path.join(root, 'contracts/test/fixtures', f), 'utf8').trim().replace(/^0x/, '');
const all = fixture('bitcoin-timestamps.hex');
export const header = i => all.slice(i * 160, (i + 1) * 160);
export const w = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');

/// Decode a Journal produced by the Rust guest's `abi_encode` (zk/wuji-header-core/examples/journal.rs).
export function journal(hex) {
  const word = i => BigInt('0x' + hex.slice(64 * (1 + i), 64 * (2 + i)));
  const signed = v => (v >= 1n << 255n ? v - (1n << 256n) : v);
  const arr = (k, f) => { const at = 1 + Number(word(k)) / 32 - 1; const n = Number(word(at)); return Array.from({ length: n }, (_, i) => f(word(at + 1 + i))); };
  const state = o => ({ hash: '0x' + word(o).toString(16).padStart(64, '0'), height: Number(word(o + 1)), bits: Number(word(o + 2)),
    time: Number(word(o + 3)), epochStart: Number(word(o + 4)), recentTimes: Array.from({ length: 11 }, (_, i) => Number(word(o + 5 + i))),
    u: signed(word(o + 16)).toString(), work: '0x' + word(o + 17).toString(16).padStart(64, '0') });
  return { prev: state(0), to: state(22), genesisHeight: Number(word(19)), checkpointInterval: Number(word(20)),
    confirmations: Number(word(21)), checkpointHeights: arr(40, Number), checkpointU: arr(41, v => signed(v).toString()) };
}

// ABI encoders mirroring ZkWujiIndex

const continuityWords = s => [s.hash.replace(/^0x/, ''), w(s.height), w(s.bits), w(s.time), w(s.epochStart), w(s.u),
  ...s.recentTimes.map(w), BigInt(s.work).toString(16).padStart(64, '0')];
export const encodeContinuity = s => '0x' + continuityWords(s).join('');
export function encodeBatch(b) {
  const head = 27, cpH = head * 32, cpU = cpH + 32 * (1 + b.checkpointHeights.length), pT = cpU + 32 * (1 + b.checkpointU.length);
  const addr = a => a.replace(/^0x/, '').padStart(64, '0');
  return '0x' + [w(32), ...continuityWords(b.to), w(cpH), w(cpU), addr(b.prover), w(b.finalAt), addr(b.disputer),
    w(b.respondBy), w(b.backed ? 1 : 0), w(pT), w(pT + 32),
    w(b.checkpointHeights.length), ...b.checkpointHeights.map(w), w(b.checkpointU.length), ...b.checkpointU.map(w), w(0), w(0)].join('');
}

