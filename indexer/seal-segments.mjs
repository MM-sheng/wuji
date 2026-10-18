// Permissionless, bounded reorg progress for WujiHeaderIndex. The contract, not this planner, validates PoW.
import { decodeContinuity } from './zk-challenge.mjs';
import { headerWork, internalHash } from './seal.mjs';

// keccak256("ReorgProgress(bytes32,bytes)"). Receipts supply the proof actually committed, even if a normal
// fold changed the finalized tip between simulation and mining of beginReorg.
export const REORG_PROGRESS_TOPIC = '0x019cc85fb97883ba26df89bd01a83a517a627e43b9b7f138a92aae8d371a8ffb';
const hash = h => h.replace(/^0x/, '').toLowerCase();
const numberWord = (hex, i) => {
  const n = BigInt('0x' + hex.slice(2 + 64 * i, 66 + 64 * i));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('reorg height exceeds safe integer range');
  return Number(n);
};

/// abi.encode(ReorgProof): three target/base words followed by the 18-word continuity encoding.
export function decodeReorgProof(proof) {
  if (!/^0x[0-9a-f]{1344}$/i.test(proof)) throw Error('unexpected reorg proof encoding');
  return { forkBase: numberWord(proof, 0), targetHeight: numberWord(proof, 1),
    targetHash: '0x' + proof.slice(130, 194), branch: decodeContinuity('0x' + proof.slice(194)) };
}

/// Produce one bounded transaction per round. A saved proof must first be authenticated on chain by the caller.
/// Existing single-call-only deployments keep using planSeal; capability detection is in zk-keeper.mjs.
export async function planSegmentedSeal({ tip, states, source, confirmations, margin, maxHeaders, proof }) {
  if (!Number.isInteger(maxHeaders) || maxHeaders < 1 || maxHeaders > 256) throw Error('invalid reorg segment limit');
  const sourceTip = await source.tip();
  if (sourceTip < tip.height) return { action: 'none' };
  if (internalHash((await source.at(tip.height)).header) === hash(tip.hash)) return { action: 'none' };
  const need = BigInt(tip.work) + BigInt(confirmations + margin) * headerWork(tip.bits);
  let from, base, forkBase;
  if (proof) {
    const p = decodeReorgProof(proof);
    if (p.targetHeight > tip.height || p.branch.height > sourceTip) {
      return { action: 'wait', reason: 'source or index observation is behind the saved reorg proof' };
    }
    // A different source fork or a fork AFTER the old target requires a new candidate. An authenticated
    // shared prefix is not sufficient: extending through its original target is intentionally rejected.
    const atTarget = internalHash((await source.at(p.targetHeight)).header);
    const atBranch = internalHash((await source.at(p.branch.height)).header);
    if (atTarget !== hash(p.targetHash) && atBranch === hash(p.branch.hash)) {
      from = p.branch; forkBase = p.forkBase;
    } else proof = null;
  }
  if (!from) {
    for (const h of Object.keys(states).map(Number).sort((a, b) => b - a)) {
      if (h >= tip.height) continue;
      const state = decodeContinuity(states[h]);
      if (state.height !== h) throw Error('saved finalized state has the wrong height');
      if (internalHash((await source.at(h)).header) === hash(state.hash)) {
        base = states[h]; from = state; forkBase = h; break;
      }
    }
    if (!from) return { action: 'wait', reason: 'no saved finalized state lies on the new chain; recover a public continuity state' };
  }
  if (proof && from.height > tip.height && BigInt(from.work) >= need) return { action: 'finish', proof, forkBase };
  const headers = [];
  let h = from.height, work = BigInt(from.work), previous = hash(from.hash);
  while (h < sourceTip && headers.length < maxHeaders && !(work >= need && h > tip.height)) {
    const header = (await source.at(++h)).header.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{160}$/.test(header) || header.slice(8, 72) !== previous) throw Error(`reorg header ${h} does not link`);
    previous = internalHash(header);
    work += headerWork(Buffer.from(header, 'hex').readUInt32LE(72));
    headers.push(header);
  }
  if (!headers.length) return { action: 'wait', reason: 'authenticated branch has not reached the current seal threshold' };
  return { action: proof ? 'extend' : 'begin', ...(proof ? { proof } : { base }),
    forkBase, branchHeight: h, headers: '0x' + headers.join('') };
}

/// One event contains ABI bytes (offset, length, data). Reject ambiguous or malformed receipts.
export function proofFromReceipt(receipt, index) {
  if (!receipt || !(receipt.status === '0x1' || receipt.status === 1)) throw Error('reorg receipt unavailable or failed');
  const events = (receipt.logs || []).filter(l => l.address?.toLowerCase() === index.toLowerCase()
    && l.topics?.[0]?.toLowerCase() === REORG_PROGRESS_TOPIC);
  if (events.length !== 1) throw Error('expected one authenticated reorg progress event');
  const data = events[0].data;
  if (!/^0x[0-9a-f]{1472}$/i.test(data) || numberWord(data, 0) !== 32 || numberWord(data, 1) !== 672) {
    throw Error('unexpected reorg progress event encoding');
  }
  const proof = '0x' + data.slice(130);
  decodeReorgProof(proof);
  return proof;
}

/// Persist from the mined receipt, never from a simulation's return. Failure before a confirmed receipt leaves
/// the previous proof intact; replay is idempotent and any submitter can recover continuations from public logs.
export async function submitReorgStep({ chain, index, plan, saveProof }) {
  if (plan.action === 'finish') {
    await chain.simulate(index, 'freezeReorg(bytes)', plan.proof);
    const tx = await chain.send('freezeReorg(bytes)', 200_000, [plan.proof]);
    saveProof(null);
    return { action: 'sealed', ...tx };
  }
  if (plan.action !== 'begin' && plan.action !== 'extend') throw Error('not a reorg transaction plan');
  const sig = plan.action === 'begin' ? 'beginReorg(bytes,bytes)' : 'extendReorg(bytes,bytes)';
  const args = [plan.action === 'begin' ? plan.base : plan.proof, plan.headers];
  const n = (plan.headers.length - 2) / 160;
  if (!Number.isInteger(n) || n < 1 || n > 256) throw Error('invalid reorg transaction size');
  await chain.simulate(index, sig, ...args);
  const tx = await chain.send(sig, 300_000 + 25_000 * n, args);
  const receipt = await chain.rpc('eth_getTransactionReceipt', [tx.hash]);
  const proof = proofFromReceipt(receipt, index);
  // Check canonical chain state as well as the receipt, including after a host-chain reorg or stale RPC reply.
  if ((await chain.simulate(index, 'isReorgProof(bytes)(bool)', proof)) !== 'true') throw Error('mined reorg proof is not authenticated');
  saveProof(proof);
  return { action: 'reorg-progress', ...tx, headers: n, branchHeight: decodeReorgProof(proof).branch.height };
}
