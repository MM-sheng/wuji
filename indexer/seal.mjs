// T13 rule 3 from the keeper's side: notice that Bitcoin reorganized past the index's finalized tip, and build the
// `freezeOnReorg(base, headers)` call that seals it once the new branch carries enough work.
//
// `base` must be a finalized state the contract recorded (`committedAt[height] == keccak256(base)`). The contract
// keeps only the hash, so the keeper keeps the states themselves: every round it saves what `continuity()` returns
// (its raw return data *is* `abi.encode(Continuity, uint32[11], uint256)`). Any saved state the new chain still
// passes through is a valid fork base; the highest one gives the shortest, cheapest branch.
// Zero dependencies; planSeal is pure apart from the source it is given, and is unit-tested in seal.test.mjs.
import fs from 'node:fs';
import { step } from './bitcoin.mjs';

const KEEP = 64; // saved states; at one fold a day this covers two months

/// Bitcoin work of a header's compact target. No range check: the contract checks the rules, this only plans.
export function headerWork(bits) {
  const size = BigInt(bits >>> 24), word = BigInt(bits & 0x007fffff);
  const target = size <= 3n ? word >> (8n * (3n - size)) : word << (8n * (size - 3n));
  return ((1n << 256n) - 1n - target) / (target + 1n) + 1n;
}

/// Save the raw continuity() return of the current finalized state, keyed by height.
export function saveState(file, hex) {
  const height = Number(BigInt('0x' + hex.slice(66, 130)));
  let states = {};
  try { states = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (states[height] === hex) return states;
  states[height] = hex;
  const keep = Object.keys(states).map(Number).sort((a, b) => b - a).slice(0, KEEP);
  states = Object.fromEntries(keep.map(h => [h, states[h]]));
  fs.writeFileSync(file + '.tmp', JSON.stringify(states));
  fs.renameSync(file + '.tmp', file);
  return states;
}

export function loadStates(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/// The contract checks `committedAt` itself (and a dry run precedes every send), so the keeper only needs the
/// header hash, in the byte order the contract stores.
export const internalHash = header => step(header).internalHash;

/// Decide what to do about the finalized tip `tip` (decoded continuity(), work as 0x hex) given `source`
/// (the most-work Bitcoin chain: tip(), at(h) → {header}) and the saved `states` ({height: continuity hex}).
/// Returns {action: 'none'} when the source still has the tip, {action: 'wait', …} after a reorg the branch
/// cannot seal yet, or {action: 'seal', base, headers, …} with the shortest branch that crosses the threshold.
export async function planSeal({ tip, states, source, confirmations, margin, maxHeaders }) {
  const at = h => source.at(h);
  const sourceTip = await source.tip();
  if (sourceTip < tip.height) return { action: 'none' }; // still syncing: nothing to compare yet
  if (internalHash((await at(tip.height)).header) === tip.hash.replace(/^0x/, '')) return { action: 'none' };

  // The finalized tip is no longer on the most-work chain. Find the highest saved state that still is.
  let base = null;
  for (const h of Object.keys(states).map(Number).sort((a, b) => b - a)) {
    if (h >= tip.height) continue;
    const hex = states[h];
    if (internalHash((await at(h)).header) === hex.slice(2, 66)) { base = { height: h, hex }; break; }
  }
  if (!base) return { action: 'wait', reason: 'Bitcoin reorganized past the finalized tip, but no saved state lies on the new chain' };

  const need = BigInt(tip.work) + BigInt(confirmations + margin) * headerWork(tip.bits);
  let work = BigInt('0x' + base.hex.slice(2 + 64 * 17, 66 + 64 * 17));
  const headers = [];
  let h = base.height, bits = tip.bits;
  while (h < sourceTip && headers.length < maxHeaders && !(work >= need && h > tip.height)) {
    const header = (await at(++h)).header;
    bits = Buffer.from(header, 'hex').readUInt32LE(72);
    work += headerWork(bits);
    headers.push(header);
  }
  if (work >= need && h > tip.height) {
    return { action: 'seal', forkBase: base.height, branchHeight: h, base: base.hex, headers: '0x' + headers.join('') };
  }
  const short = Number((need - work + headerWork(bits) - 1n) / headerWork(bits));
  const reason = headers.length >= maxHeaders
    ? `the branch from ${base.height} needs more than ${maxHeaders} headers; an older saved state is required`
    : `the branch from ${base.height} is about ${short} blocks short of the seal threshold`;
  return { action: 'wait', reason, forkBase: base.height, short };
}
