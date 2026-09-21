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
  constructor(urls = (process.env.BITCOIN_API || 'https://mempool.space/api,https://blockstream.info/api').split(','), options = {}) {
    this.kind = options.kind ?? process.env.BITCOIN_API_KIND ?? 'esplora';
    if (!['esplora', 'bitcoind-rest'].includes(this.kind)) throw Error('Unknown BITCOIN_API_KIND');
    const configuredDelay = options.requestDelayMs ?? (process.env.BITCOIN_REQUEST_DELAY_MS || undefined);
    const delay = configuredDelay === undefined ? 1000 : Number(configuredDelay);
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 60000) throw Error('Invalid BITCOIN_REQUEST_DELAY_MS');
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.sources = [...new Set(urls.map(base => base.trim().replace(/\/$/, '')))].map(base => {
      const url = new URL(base);
      if (!['http:', 'https:'].includes(url.protocol)) throw Error('Bitcoin source must use HTTP(S)');
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      const spacing = url.hostname === 'blockstream.info' ? Math.max(6000, delay) : local && configuredDelay === undefined ? 0 : delay;
      return { base, host: url.hostname, spacing, nextAt: 0, failures: 0 };
    });
    if (!this.sources.length) throw Error('At least one Bitcoin source is required');
    this.queue = Promise.resolve();
    this.headers = new Map();
    this.headerRequests = new Map();
  }

  get(route, json = false) {
    // Serialize requests, including concurrent callers, so a cooldown applies to every route.
    const request = this.queue.then(() => this.request(route, json));
    this.queue = request.catch(() => {});
    return request;
  }

  async request(route, json) {
    const attempts = new Map(this.sources.map(source => [source, 0]));
    const deadline = this.now() + 30000;
    let lastError;
    for (;;) {
      const eligible = this.sources.filter(source => attempts.get(source) < 4);
      if (!eligible.length) throw lastError;
      const now = this.now();
      // Prefer the first configured source when available; don't wait on it if a fallback is ready.
      const source = eligible.find(s => s.nextAt <= now) ?? eligible.reduce((a, b) => a.nextAt <= b.nextAt ? a : b);
      const wait = Math.max(0, source.nextAt - now);
      if (now + wait >= deadline) {
        throw Error(`${lastError?.message ?? 'Bitcoin sources unavailable'}; retry in ${Math.max(1, Math.ceil(wait / 1000))}s`);
      }
      if (wait) await this.sleep(wait);
      const remaining = deadline - this.now();
      if (remaining <= 0) throw Error('Bitcoin request time budget exhausted');
      attempts.set(source, attempts.get(source) + 1);
      source.nextAt = this.now() + source.spacing;
      try {
        const response = await this.fetcher(source.base + route, { signal: AbortSignal.timeout(Math.min(20000, remaining)) });
        if (!response.ok) {
          const error = Error(`HTTP ${response.status}`);
          error.retryable = response.status === 429 || response.status >= 500;
          error.backoff = response.status === 429 ? 10000 : 1000;
          const value = response.headers?.get('retry-after')?.trim();
          const delay = value ? (/^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - this.now()) : 0;
          error.retryAfter = Number.isFinite(delay) ? Math.max(0, delay) : 0;
          // Discard error bodies without leaving an unread HTTP connection behind.
          await response.body?.cancel().catch(() => {});
          throw error;
        }
        const result = json ? await response.json() : (await response.text()).trim();
        source.failures = 0;
        return result;
      } catch (error) {
        // Do not echo a configured URL: private node URLs may contain credentials.
        lastError = Error(`Bitcoin source ${source.host}: ${error.retryable === undefined ? error.name : error.message}`);
        if (error.retryable === false) {
          attempts.set(source, 4); // A permanent HTTP error is tried once, then use another source.
        } else {
          source.failures = Math.min(source.failures + 1, 7);
          const backoff = Math.min(60000, (error.backoff ?? 1000) * 2 ** (source.failures - 1));
          // Keep the server's full Retry-After even when it exceeds this request's time budget.
          source.nextAt = Math.max(source.nextAt, this.now() + Math.max(backoff, error.retryAfter ?? 0));
        }
      }
    }
  }

  async tip() {
    const value = this.kind === 'bitcoind-rest' ? (await this.get('/rest/chaininfo.json', true)).blocks : await this.get('/blocks/tip/height');
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw Error('Invalid Bitcoin tip height');
    return Number(value);
  }

  async hashAt(height) {
    if (!Number.isSafeInteger(height) || height < 0) throw Error('Invalid Bitcoin height');
    const hash = this.kind === 'bitcoind-rest' ? (await this.get('/rest/blockhashbyheight/' + height + '.json', true)).blockhash : await this.get('/block-height/' + height);
    if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) throw Error('Invalid Bitcoin block hash');
    return hash.toLowerCase();
  }

  async header(hash) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw Error('Invalid Bitcoin block hash');
    if (this.headers.has(hash)) {
      const header = this.headers.get(hash);
      this.headers.delete(hash); this.headers.set(hash, header);
      return header;
    }
    if (this.headerRequests.has(hash)) return this.headerRequests.get(hash);
    const request = (async () => {
      const route = this.kind === 'bitcoind-rest' ? '/rest/headers/' + hash + '.hex?count=1' : '/block/' + hash + '/header';
      const raw = await this.get(route);
      if (!/^[0-9a-fA-F]{160}$/.test(raw) || step(raw).hash !== hash) throw Error('Bitcoin source header/hash mismatch');
      const header = raw.toLowerCase();
      this.headers.set(hash, header);
      if (this.headers.size > 4096) this.headers.delete(this.headers.keys().next().value);
      return header;
    })();
    this.headerRequests.set(hash, request);
    try { return await request; } finally { this.headerRequests.delete(hash); }
  }

  async at(height) {
    // Never cache height -> hash or tip: both can change during a reorg. Only verified immutable
    // header bytes are cached by their own hash, and still undergo the caller's linkage checks.
    const hash = await this.hashAt(height);
    return { height, hash, header: await this.header(hash) };
  }
}
