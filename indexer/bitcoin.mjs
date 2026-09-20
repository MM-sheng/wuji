import { createHash } from 'node:crypto';
export const sha256 = bytes => createHash('sha256').update(bytes).digest();
export const sha256d = bytes => sha256(sha256(bytes));
export function step(header) {
  const raw = Buffer.isBuffer(header) ? header : Buffer.from(header.replace(/^0x/, ''), 'hex');
  if (raw.length !== 80) throw Error('Bitcoin header must be 80 bytes');
  const internalHash = sha256d(raw), R = sha256(internalHash);
  const delta = [...R].reduce((a, b) => a + b, 0) - 4080;
  return { hash: Buffer.from(internalHash).reverse().toString('hex'), internalHash: internalHash.toString('hex'), R: R.toString('hex'), delta, S_wad: (BigInt(delta) * 12000000000000n).toString(), timestamp: raw.readUInt32LE(68) };
}
export function encodeHeader(b) {
  const h = Buffer.alloc(80); h.writeInt32LE(b.version | 0, 0);
  Buffer.from(b.previousblockhash || '00'.repeat(32), 'hex').reverse().copy(h, 4);
  Buffer.from(b.merkle_root, 'hex').reverse().copy(h, 36);
  h.writeUInt32LE(b.timestamp, 68); h.writeUInt32LE(b.bits, 72); h.writeUInt32LE(b.nonce, 76);
  if (step(h).hash !== b.id) throw Error(`Header hash mismatch at ${b.height}`);
  return h;
}
export class BitcoinAPI {
  constructor(urls = (process.env.BITCOIN_API || 'https://mempool.space/api,https://blockstream.info/api').split(',')) { this.urls = urls; }
  async get(route, json = false) {
    for (let retry = 0; retry < 4; retry++) for (const base of this.urls) {
      try {
        const r = await fetch(base.replace(/\/$/, '') + route, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw Error(`HTTP ${r.status}`);
        return json ? await r.json() : (await r.text()).trim();
      } catch (e) { if (retry === 3 && base === this.urls.at(-1)) throw e; }
    }
  }
  async tip() { return process.env.BITCOIN_API_KIND === 'bitcoind-rest' ? (await this.get('/rest/chaininfo.json',true)).blocks : Number(await this.get('/blocks/tip/height')); }
  async hashAt(height) { return process.env.BITCOIN_API_KIND === 'bitcoind-rest' ? (await this.get('/rest/blockhashbyheight/'+height+'.json',true)).blockhash : this.get('/block-height/'+height); }
  async at(height) { if(process.env.BITCOIN_API_KIND === 'bitcoind-rest'){const result=await this.get('/rest/blockhashbyheight/'+height+'.json',true); const hash=result.blockhash; const header=(await this.get('/rest/headers/'+hash+'.hex?count=1')).slice(0,160); return {height,hash,header};} const hash = await this.get('/block-height/' + height); return { height, hash, header: await this.get('/block/' + hash + '/header') }; }
}
