// Public Esplora block metadata contains all six header fields; verify the reconstructed hash.
import fs from 'node:fs';
import { BitcoinAPI, encodeHeader, step } from '../indexer/bitcoin.mjs';
const api = new BitcoinAPI();
const start = 798336, count = 2028, cpHeight = start - 1;
const dir = new URL('../contracts/test/fixtures/', import.meta.url);
fs.mkdirSync(dir, {recursive:true});
const cp = await api.at(cpHeight), epoch = await api.at(Math.floor(cpHeight / 2016) * 2016);
const records = new Map();
const ends = []; for (let h = start + count - 1; h >= start; h -= 10) ends.push(h);
let cursor = 0;
await Promise.all(Array.from({length: 4}, async () => {
  while (cursor < ends.length) {
    const at = ends[cursor++];
    const blocks = await api.get('/blocks/' + at, true);
    for (const b of blocks) if (b.height >= start && b.height < start + count) records.set(b.height, encodeHeader(b));
    if (records.size % 200 < 10) console.log('headers', records.size);
  }
}));
const headers = []; let prev = cp.hash, U = 0; const vectors = [];
for (let h = start; h < start + count; h++) {
 const raw = records.get(h); if (!raw) throw Error('missing ' + h);
 if (Buffer.from(raw.subarray(4,36)).reverse().toString('hex') !== prev) throw Error('broken link');
 const s = step(raw); U += s.delta; headers.push(raw); vectors.push(s.R); prev = s.hash;
}
fs.writeFileSync(new URL('bitcoin-798336.hex', dir), '0x' + Buffer.concat(headers).toString('hex'));
fs.writeFileSync(new URL('bitcoin-vectors.hex', dir), '0x' + vectors.join(''));
fs.writeFileSync(new URL('bitcoin.json', dir), JSON.stringify({ start, count, checkpointHeader: cp.header, checkpointHeight: cpHeight, epochStartTime: step(epoch.header).timestamp, U, S_wad: (BigInt(U)*12000000000000n).toString(), known800000: step(records.get(800000)), source: api.urls }, null, 2)+'\n');
console.log('complete', U);
