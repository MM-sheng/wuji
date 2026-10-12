// Content-addressed Bitcoin headers for pricing the chain that an index actually finalized, including orphans.
// Zero dependencies. A height is only a fallback locator; the contract's raw SHA256d anchor authenticates bytes.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { step } from './bitcoin.mjs';

const normalizedHash = value => {
  const hash = String(value ?? '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash) || /^0+$/.test(hash)) throw Error('a nonzero raw Bitcoin anchor hash is required');
  return hash;
};
const normalizedHeader = value => {
  const hex = Buffer.isBuffer(value) ? value.toString('hex') : String(value ?? '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{160}$/.test(hex)) throw Error('historical Bitcoin header must be 80 bytes');
  return hex;
};
const syncDir = dir => {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

export class HeaderHistory {
  constructor(directory) { this.directory = directory; fs.mkdirSync(directory, { recursive: true }); }

  file(rawHash) { const h = normalizedHash(rawHash); return path.join(this.directory, h.slice(0, 2), h + '.bin'); }

  get(rawHash) {
    const expected = normalizedHash(rawHash);
    let bytes;
    try { bytes = fs.readFileSync(this.file(expected)); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const hex = normalizedHeader(bytes);
    if (step(hex).internalHash !== expected) throw Error(`corrupt archived Bitcoin header ${expected}`);
    return hex;
  }

  /// Synchronous durable writes finish before a caller is allowed to broadcast a fold. Different branches at
  /// the same height occupy different hashes; a crash never leaves a partially written canonical cache file.
  put(header) {
    const hex = normalizedHeader(header), hash = step(hex).internalHash;
    if (this.get(hash) !== null) return hash;
    const file = this.file(hash), dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    syncDir(this.directory);
    const temporary = file + `.tmp-${process.pid}-${randomUUID()}`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, Buffer.from(hex, 'hex')); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file); syncDir(dir);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return hash;
  }

  putBatch(headers) {
    const list = Array.isArray(headers) ? headers.map(normalizedHeader) : splitHeaders(headers);
    for (let i = 1; i < list.length; i++) {
      if (list[i].slice(8, 72) !== step(list[i - 1]).internalHash) throw Error('historical header batch does not link');
    }
    return list.map(h => this.put(h));
  }

  /// Return from..to inclusive, in forward order, by walking PARENTS from the authenticated header at to.
  /// HTTP/P2P source.header takes display-endian hashes; pool/index anchors use raw SHA256d digest order.
  async headersFor(source, from, to, anchorHash, within = async p => p) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from + 1 > 1024) {
      throw Error('historical header range must contain 1..1024 heights');
    }
    let expected = normalizedHash(anchorHash);
    const headers = [];
    for (let h = to; h >= from; h--) {
      let header = this.get(expected);
      if (header === null) {
        if (typeof source.header === 'function') {
          try {
            const displayHash = Buffer.from(expected, 'hex').reverse().toString('hex');
            const candidate = normalizedHeader(await within(source.header(displayHash), `Bitcoin header by hash ${displayHash}`));
            if (step(candidate).internalHash === expected) header = candidate;
          } catch { /* A pruned or orphan-unaware source may still have this exact header at its height. */ }
        }
        if (header === null && typeof source.at === 'function') {
          try {
            const candidate = normalizedHeader((await within(source.at(h), `Bitcoin header ${h}`)).header);
            if (step(candidate).internalHash === expected) header = candidate;
          } catch { /* Report a precise unavailable hash below; never substitute another branch. */ }
        }
        if (header === null) throw Error(`historical Bitcoin header unavailable at ${h}, raw hash ${expected}; restore archived headers or public fold calldata`);
        this.put(header);
      }
      // get() and both fetch routes check SHA256d against expected before the parent becomes the next anchor.
      headers.push(header); expected = header.slice(8, 72);
    }
    return '0x' + headers.reverse().join('');
  }
}

function splitHeaders(value) {
  const hex = String(value ?? '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 160 !== 0) throw Error('invalid historical header batch');
  return hex.match(/.{160}/g);
}

/// Recover raw headers from a public direct foldHeaders(bytes,address[]) transaction. Proof-only journal
/// transactions do not contain these bytes. The caller supplies transaction IDs, never private runtime data.
export function headersFromFoldCalldata(input) {
  if (typeof input !== 'string' || input.length > 2_000_000 || !/^0xdca3930f[0-9a-f]+$/i.test(input)) {
    throw Error('not direct foldHeaders calldata');
  }
  const args = input.slice(10), word = at => {
    if (at < 0 || at + 64 > args.length) throw Error('truncated fold calldata');
    const n = BigInt('0x' + args.slice(at, at + 64));
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('invalid fold calldata offset');
    return Number(n);
  };
  const offset = word(0);
  if (offset < 64 || offset % 32) throw Error('invalid fold calldata offset');
  const length = word(offset * 2), begin = (offset + 32) * 2;
  if (!length || length % 80 || length > 512 * 80 || begin + length * 2 > args.length) throw Error('invalid fold header length');
  return '0x' + args.slice(begin, begin + length * 2);
}

export async function recoverFoldTransaction({ history, rpc, index, transactionHash }) {
  if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw Error('invalid recovery transaction hash');
  const tx = await rpc('eth_getTransactionByHash', [transactionHash]);
  const receipt = await rpc('eth_getTransactionReceipt', [transactionHash]);
  if (!tx || tx.hash?.toLowerCase() !== transactionHash.toLowerCase() || tx.to?.toLowerCase() !== index.toLowerCase()
    || !receipt || receipt.transactionHash?.toLowerCase() !== transactionHash.toLowerCase()
    || !(receipt.status === '0x1' || receipt.status === 1)) throw Error('recovery transaction is not a successful direct index call');
  const headers = headersFromFoldCalldata(tx.input);
  history.putBatch(headers);
  return (headers.length - 2) / 160;
}
