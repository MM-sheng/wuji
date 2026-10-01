// Shared pieces for the T12 challenge window: ABI decoding of ZkWujiIndex views, a JavaScript replay of
// the contract's fold (so a watcher can say what a batch *should* claim), and a cast-based sender.
// Zero dependencies; pure functions are unit-tested in zk-challenge.test.mjs.
import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { sha256, sha256d } from './bitcoin.mjs';
import { rpcRequest } from './evm-rpc.mjs';
import { assertChain } from './networks.mjs';

const word = (hex, i) => BigInt('0x' + hex.slice(2 + 64 * i, 66 + 64 * i));
const signed = v => (v >= 1n << 255n ? v - (1n << 256n) : v);
const address = v => '0x' + v.toString(16).padStart(40, '0');

/// continuity() / stateBefore(id): (Continuity{hash,height,bits,time,epochStart,u}, uint32[11], uint256): 18 words.
export function decodeContinuity(hex) {
  if (!/^0x[0-9a-f]{1152}$/i.test(hex)) throw Error('unexpected continuity() encoding');
  return {
    hash: '0x' + hex.slice(2, 66),
    height: Number(word(hex, 1)), bits: Number(word(hex, 2)), time: Number(word(hex, 3)),
    epochStart: Number(word(hex, 4)), u: signed(word(hex, 5)).toString(),
    recentTimes: Array.from({ length: 11 }, (_, i) => Number(word(hex, 6 + i))),
    work: '0x' + hex.slice(2 + 64 * 17, 66 + 64 * 17),
  };
}

/// batch(id) returns one dynamic tuple: an offset word, then Batch's head (27 words) and its arrays.
export function decodeBatch(hex) {
  const base = Number(word(hex, 0)) / 32;
  const f = k => word(hex, base + k);
  const array = (k, map) => {
    const at = base + Number(f(k)) / 32, n = Number(word(hex, at));
    return Array.from({ length: n }, (_, i) => map(word(hex, at + 1 + i)));
  };
  return {
    to: {
      hash: '0x' + f(0).toString(16).padStart(64, '0'), height: Number(f(1)), bits: Number(f(2)),
      time: Number(f(3)), epochStart: Number(f(4)), u: signed(f(5)).toString(),
      recentTimes: Array.from({ length: 11 }, (_, i) => Number(f(6 + i))),
      work: '0x' + f(17).toString(16).padStart(64, '0'),
    },
    checkpointHeights: array(18, Number),
    checkpointU: array(19, v => signed(v).toString()),
    prover: address(f(20)), finalAt: Number(f(21)), disputer: address(f(22)), respondBy: Number(f(23)),
    backed: f(24) !== 0n,
  };
}

// ---------------------------------------------------------------- the contract's fold, in JavaScript

const POW_LIMIT = (1n << 224n) - 1n;
export function targetOf(bits) {
  const size = BigInt(bits >>> 24), w = BigInt(bits & 0x007fffff);
  const t = size <= 3n ? w >> (8n * (3n - size)) : w << (8n * (size - 3n));
  if (t === 0n || t > POW_LIMIT) throw Error('target range');
  return t;
}
export const workOf = target => ((1n << 256n) - 1n - target) / (target + 1n) + 1n;

/// Replay `headers` (hex strings, 80 bytes each) from `start` exactly as `_replay` does: the state is
/// committed at `tip − confirmations`, and checkpoint U values are collected at series boundaries.
/// Returns the claim an honest batch over these headers must make. Consensus rules are not re-checked
/// here; the headers come from independent sources and are compared, and `back` re-checks everything.
export function replay(start, headers, { genesisHeight, checkpointInterval, confirmations }) {
  if (headers.length <= confirmations) throw Error('not enough confirmations');
  const foldTarget = start.height + headers.length - confirmations;
  let s = { hash: start.hash.replace(/^0x/, ''), height: start.height, bits: start.bits, time: start.time,
    epochStart: start.epochStart, u: BigInt(start.u), recentTimes: [...start.recentTimes], work: BigInt(start.work) };
  let committed = null;
  const checkpointHeights = [], checkpointU = [];
  for (const hex of headers) {
    const raw = Buffer.from(hex.replace(/^0x/, ''), 'hex');
    if (raw.subarray(4, 36).toString('hex') !== s.hash) throw Error(`header ${s.height + 1} does not link`);
    const internal = sha256d(raw), bits = raw.readUInt32LE(72), time = raw.readUInt32LE(68);
    const height = s.height + 1;
    s = {
      hash: internal.toString('hex'), height, bits, time,
      epochStart: height % 2016 === 0 ? time : s.epochStart,
      u: s.u + BigInt([...sha256(internal)].reduce((a, b) => a + b, 0) - 4080),
      recentTimes: [...s.recentTimes.slice(1), time],
      work: s.work + workOf(targetOf(bits)),
    };
    if (height <= foldTarget) {
      if (height >= genesisHeight && (height + 1 - genesisHeight) % checkpointInterval === 0) {
        checkpointHeights.push(height); checkpointU.push(s.u.toString());
      }
      committed = s;
    }
  }
  return {
    to: { ...committed, hash: '0x' + committed.hash, u: committed.u.toString(),
      work: '0x' + committed.work.toString(16).padStart(64, '0') },
    checkpointHeights, checkpointU,
  };
}

/// Field-by-field comparison of a claimed batch with the replayed truth; returns the differing fields.
export function differences(claimed, truth) {
  const out = [];
  for (const k of ['hash', 'height', 'bits', 'time', 'epochStart', 'u']) {
    if (String(claimed.to[k]).toLowerCase() !== String(truth.to[k]).toLowerCase()) out.push(k);
  }
  if (BigInt(claimed.to.work) !== BigInt(truth.to.work)) out.push('work');
  if (claimed.to.recentTimes.join() !== truth.to.recentTimes.join()) out.push('recentTimes');
  if (claimed.checkpointHeights.join() !== truth.checkpointHeights.join()) out.push('checkpointHeights');
  if (claimed.checkpointU.join() !== truth.checkpointU.join()) out.push('checkpointU');
  return out;
}

// ---------------------------------------------------------------- chain access

const CAST = process.env.CAST || path.join(os.homedir(), '.foundry/bin/cast');
const selectors = new Map();
export const sel = sig => {
  if (!selectors.has(sig)) selectors.set(sig, execFileSync(CAST, ['sig', sig], { encoding: 'utf8' }).trim());
  return selectors.get(sig);
};
export const uint = n => BigInt(n).toString(16).padStart(64, '0');

/// cast --json reports failures on stdout ({"errors":[{"message"}]}); stderr is often empty.
const castError = out => { try { return JSON.parse(out).errors?.map(e => e.message).join('; '); } catch { return ''; } };

/// Reads and signed writes against one contract. Signs with `cast` and an encrypted keystore (or anvil's
/// unlocked account on chain 31337); never handles a key.
export function contractClient({ rpc, chainId, to, env = process.env }) {
  const call = async data => rpcRequest(rpc, 'eth_call', [{ to, data }, 'latest']);
  const unlocked = env.ZK_UNLOCKED_FROM;
  if (unlocked && chainId !== 31337) throw Error('ZK_UNLOCKED_FROM is for anvil (chain 31337) only');
  if (!unlocked && (!env.KEYSTORE_ACCOUNT || !env.PASSWORD_FILE)) throw Error('need KEYSTORE_ACCOUNT and PASSWORD_FILE');
  async function send(sig, gas, args = [], value) {
    assertChain(await rpcRequest(rpc, 'eth_chainId', []), chainId);
    const who = unlocked ? ['--unlocked', '--from', unlocked] : ['--account', env.KEYSTORE_ACCOUNT, '--password-file', env.PASSWORD_FILE];
    const price = env.KEEPER_GAS_PRICE ? ['--legacy', '--gas-price', env.KEEPER_GAS_PRICE] : [];
    const paid = value ? ['--value', String(value)] : [];
    const out = await new Promise((resolve, reject) => execFile(CAST, ['send', to, sig, ...args, '--rpc-url', rpc,
      '--chain', String(chainId), '--gas-limit', String(gas), ...who, ...price, ...paid, '--json'], { maxBuffer: 64 << 20 },
    (e, so, se) => e ? reject(Error(castError(so) || String(se || e.message).split('\n').find(Boolean))) : resolve(so)));
    const r = JSON.parse(out);
    if (r.status !== '0x1' && r.status !== 1) throw Error(sig.split('(')[0] + ' reverted ' + r.transactionHash);
    return { hash: r.transactionHash, gas: parseInt(r.gasUsed, 16) };
  }
  return { call, send, rpc: (m, p) => rpcRequest(rpc, m, p) };
}
