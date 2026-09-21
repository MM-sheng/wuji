import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BitcoinAPI, step } from './bitcoin.mjs';

const fixture = fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin-798336.hex', import.meta.url), 'utf8').trim().replace(/^0x/, '');
const raw = [fixture.slice(0, 160), fixture.slice(160, 320)];
const hashes = raw.map(header => step(header).hash);
const response = (value = '798336', status = 200, retryAfter) => ({
  ok: status === 200, status, text: async () => String(value), json: async () => value,
  headers: { get: name => name === 'retry-after' ? retryAfter : null }
});
function setup(handler, { urls = ['https://one.example'], ...options } = {}) {
  let time = Date.UTC(2026, 8, 21);
  const calls = [], waits = [];
  const api = new BitcoinAPI(urls, {
    requestDelayMs: 0, kind: 'esplora', ...options, now: () => time,
    sleep: async ms => { waits.push(ms); time += ms; },
    fetcher: async url => { const call = { url: new URL(url), time }; calls.push(call); return handler(call, calls.length); }
  });
  return { api, calls, waits, advance: ms => { time += ms; } };
}

test('429 honours Retry-After across routes while an available configured fallback continues', async () => {
  let failed = false;
  const { api, calls, advance } = setup(({ url }) => {
    if (url.hostname === 'one.example' && !failed) { failed = true; return response('', 429, '120'); }
    return response(url.pathname.startsWith('/block-height/') ? hashes[0] : '798336');
  }, { urls: ['https://one.example', 'https://two.example'] });
  assert.equal(await api.tip(), 798336);
  assert.equal(await api.hashAt(798336), hashes[0]);
  advance(119999);
  await api.tip();
  assert.deepEqual(calls.map(c => c.url.hostname), ['one.example', 'two.example', 'two.example', 'two.example']);
  advance(1);
  await api.tip();
  assert.equal(calls.at(-1).url.hostname, 'one.example');
  assert.equal(calls.at(-1).time - calls[0].time, 120000);
});

test('a long HTTP-date cooldown fails promptly, persists across calls, and later recovers', async () => {
  const { api, calls, waits, advance } = setup(({ time }, n) => n === 1 ? response('', 503, new Date(time + 3600000).toUTCString()) : response());
  await assert.rejects(api.tip(), /HTTP 503; retry in 3600s/);
  await assert.rejects(api.hashAt(798336), /retry in 3600s/);
  assert.equal(calls.length, 1, 'a later route must not bypass the server cooldown');
  assert.deepEqual(waits, [], 'do not occupy the keeper for an hour');
  advance(3600000);
  assert.equal(await api.tip(), 798336, 'a rejected request must not poison the queue');
});

test('repeated 429 uses exponential backoff even with missing, invalid or zero Retry-After', async () => {
  for (const retryAfter of [undefined, 'nonsense', '0']) {
    const { api, calls, waits } = setup(() => response('', 429, retryAfter));
    await assert.rejects(api.tip(), /HTTP 429; retry in 20s/);
    assert.deepEqual(calls.map(c => c.time - calls[0].time), [0, 10000]);
    assert.deepEqual(waits, [10000]);
    await assert.rejects(api.tip(), /HTTP 429; retry in 40s/);
    assert.equal(calls.at(-1).time - calls[0].time, 30000, 'next poll retains the prior cooldown');
  }
});

test('a permanent HTTP error is not retried at the same source; fallback is permitted', async () => {
  const { api, calls } = setup(({ url }) => response('798336', url.hostname === 'one.example' ? 404 : 200), { urls: ['https://one.example', 'https://two.example'] });
  assert.equal(await api.tip(), 798336);
  assert.equal(calls.length, 2);
  const failed = setup(() => response('', 403));
  await assert.rejects(failed.api.tip(), /HTTP 403/);
  assert.equal(failed.calls.length, 1);
});

test('network failures back off, then return fresh data without leaking a private source URL', async () => {
  const { api, calls } = setup((_, n) => { if (n <= 2) throw TypeError('secret-url-token'); return response(); });
  assert.equal(await api.tip(), 798336);
  assert.deepEqual(calls.map(c => c.time - calls[0].time), [0, 1000, 3000]);
  const failed = setup(() => { throw TypeError('secret-url-token'); });
  await assert.rejects(failed.api.tip(), error => /one.example: TypeError/.test(error.message) && !error.message.includes('secret-url-token'));
  assert.equal(failed.calls.length, 4);
});

test('concurrent callers are spaced and Blockstream has a six-second minimum', async () => {
  for (const [url, spacing] of [['https://one.example', 1250], ['https://blockstream.info/api', 6000]]) {
    const { api, calls } = setup(() => response(), { urls: [url], requestDelayMs: 1250 });
    assert.deepEqual(await Promise.all([api.tip(), api.tip(), api.tip()]), [798336, 798336, 798336]);
    assert.deepEqual(calls.map(c => c.time - calls[0].time), [0, spacing, spacing * 2]);
  }
});

test('an empty Compose delay keeps public throttling and the loopback default', async () => {
  const previous = process.env.BITCOIN_REQUEST_DELAY_MS;
  process.env.BITCOIN_REQUEST_DELAY_MS = '';
  try {
    for (const [url, spacing] of [['https://one.example', 1000], ['http://127.0.0.1:8332', 0]]) {
      const { api, calls } = setup(() => response(), { urls: [url], requestDelayMs: undefined });
      await api.tip(); await api.tip();
      assert.equal(calls[1].time - calls[0].time, spacing);
    }
  } finally {
    if (previous === undefined) delete process.env.BITCOIN_REQUEST_DELAY_MS;
    else process.env.BITCOIN_REQUEST_DELAY_MS = previous;
  }
});

test('immutable header caching never caches height or tip, so replacements and reversals remain visible', async () => {
  let branch = 0, tip = 798336;
  const { api, calls } = setup(({ url }) => {
    if (url.pathname === '/blocks/tip/height') return response(tip);
    if (url.pathname === '/block-height/798336') return response(hashes[branch]);
    return response(raw[hashes.indexOf(url.pathname.split('/')[2])]);
  });
  assert.equal(await api.tip(), 798336);
  assert.equal((await api.at(798336)).header, raw[0]);
  assert.equal((await api.at(798336)).header, raw[0]);
  branch = 1; tip++;
  assert.equal(await api.tip(), 798337);
  assert.equal((await api.at(798336)).header, raw[1]);
  branch = 0;
  assert.equal((await api.at(798336)).hash, hashes[0]);
  assert.equal(calls.filter(c => c.url.pathname === '/block-height/798336').length, 4);
  assert.equal(calls.filter(c => c.url.pathname.endsWith('/header')).length, 2);
});

test('a mismatched or malformed header never enters the cache, and the same hash can be retried', async () => {
  for (const bad of [raw[1], raw[0] + '00', 'z'.repeat(160)]) {
    let value = bad;
    const { api, calls } = setup(({ url }) => response(url.pathname.startsWith('/block-height/') ? hashes[0] : value));
    await assert.rejects(api.at(798336), /header\/hash mismatch/);
    value = raw[0];
    assert.equal((await api.at(798336)).header, raw[0]);
    assert.equal(calls.filter(c => c.url.pathname.endsWith('/header')).length, 2);
  }
});

test('Core REST uses the same verified immutable cache and refreshes canonical hashes', async () => {
  let branch = 0;
  const { api, calls } = setup(({ url }) => {
    if (url.pathname === '/rest/chaininfo.json') return response({ blocks: 798336 });
    if (url.pathname.startsWith('/rest/blockhashbyheight/')) return response({ blockhash: hashes[branch] });
    assert.equal(url.search, '?count=1');
    return response(raw[hashes.indexOf(url.pathname.split('/')[3].replace('.hex', ''))]);
  }, { kind: 'bitcoind-rest' });
  assert.equal(await api.tip(), 798336);
  assert.equal((await api.at(798336)).header, raw[0]);
  assert.equal((await api.at(798336)).header, raw[0]);
  branch = 1;
  assert.equal((await api.at(798336)).header, raw[1]);
  assert.equal(calls.filter(c => c.url.pathname.startsWith('/rest/headers/')).length, 2);
});

test('overlapping confirmation checks download each immutable header once while rereading every height', async () => {
  const rows = Array.from({ length: 11 }, (_, i) => fixture.slice(i * 160, (i + 1) * 160));
  const byHash = new Map(rows.map(header => [step(header).hash, header]));
  const { api, calls } = setup(({ url }) => {
    if (url.pathname.startsWith('/block-height/')) return response(step(rows[Number(url.pathname.split('/').at(-1)) - 798336]).hash);
    return response(byHash.get(url.pathname.split('/')[2]));
  });
  for (let candidate = 0; candidate < 5; candidate++) {
    const blocks = await Promise.all(Array.from({ length: 7 }, (_, k) => api.at(798336 + candidate + k)));
    assert.equal(blocks[0].header, rows[candidate]);
  }
  assert.equal(calls.filter(c => c.url.pathname.endsWith('/header')).length, 11);
  assert.equal(calls.filter(c => c.url.pathname.startsWith('/block-height/')).length, 35);
  await Promise.all([api.at(798336), api.at(798336)]);
  assert.equal(calls.filter(c => c.url.pathname.endsWith('/header')).length, 11);
});

test('concurrent requests for one uncached hash share a single verified download', async () => {
  const { api, calls } = setup(() => response(raw[0]));
  assert.deepEqual(await Promise.all([api.header(hashes[0]), api.header(hashes[0])]), [raw[0], raw[0]]);
  assert.equal(calls.length, 1);
});

test('header cache is bounded and evicted headers are fetched again', async () => {
  const rows = fs.readFileSync(new URL('../contracts/test/fixtures/bitcoin-timestamps.hex', import.meta.url), 'utf8').trim().replace(/^0x/, '').match(/.{160}/g).slice(0, 4097);
  assert.equal(rows.length, 4097);
  const byHash = new Map(rows.map(header => [step(header).hash, header]));
  const { api, calls } = setup(({ url }) => response(byHash.get(url.pathname.split('/')[2])));
  for (const hash of byHash.keys()) await api.header(hash);
  assert.equal(api.headers.size, 4096);
  await api.header(byHash.keys().next().value);
  assert.equal(calls.length, 4098);
  assert.equal(api.headers.size, 4096);
});

test('malformed source heights and hashes fail closed before requesting a header', async () => {
  for (const value of ['', '-1', '1.5', 'Infinity', '9007199254740992', 'NaN']) {
    const { api } = setup(() => response(value));
    await assert.rejects(api.tip(), /Invalid Bitcoin tip height/);
  }
  const { api, calls } = setup(() => response('not-a-hash'));
  await assert.rejects(api.at(798336), /Invalid Bitcoin block hash/);
  assert.equal(calls.length, 1);
  await assert.rejects(api.at(-1), /Invalid Bitcoin height/);
  assert.equal(calls.length, 1);
});
