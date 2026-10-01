import test from 'node:test'; import assert from 'node:assert/strict';
import { readPool, readAccount, maintainPool, annualVol } from './accounts.mjs';

const word = n => '0x' + (BigInt(n) < 0n ? (1n << 256n) + BigInt(n) : BigInt(n)).toString(16).padStart(64, '0');
const pool = '0x' + 'aa'.repeat(20), asset = '0x' + 'bb'.repeat(20), index = '0x' + 'cc'.repeat(20), owner = '0x' + 'dd'.repeat(20);
const E = 10n ** 18n;

function fixture({ yin = 100n * E, yang = 150n * E, head = 0, queue = [1008], folded = 1010, frozen = false, indexFrozen = false,
  accounts = { 1: { yang: true, enter: 1002, exit: 0, principal: 100n * E, value: 120n * E, raw: 120n * E } }, surplus = 0n } = {}) {
  const sends = [];
  const at = (to, data) => {
    const sel = data.slice(0, 10), arg = data.length > 10 ? BigInt('0x' + data.slice(10, 74)) : 0n;
    if (to === asset) return word(yin + yang + 5n * E);
    if (to === index) return sel === '0x25159aa9' ? word(folded) : word(indexFrozen ? 1 : 0);
    const a = accounts[Number(arg)];
    switch (sel) {
      case '0xa932492f': return word(11_500_000_000_000_000_000n);
      case '0xa0dc2758': return word(6); case '0x69b41170': return word(2); case '0xbf333f2c': return word(30);
      case '0x38d52e0f': return word(BigInt(asset)); case '0x2986c0e5': return word(BigInt(index));
      case '0x908de6c2': return word(arg === 0n ? yin : yang);
      case '0xedaafe20': return word(5n * E); case '0xbbcac557': return word(0);
      case '0x8f7dcfa3': return word(head); case '0xab91c7b0': return word(queue.length);
      case '0xddf0b009': return word(queue[Number(arg)]); case '0x7dd7307d': return word(1020);
      case '0x054f7d9c': return word(frozen ? 1 : 0); case '0x61b8ce8c': return word(Object.keys(accounts).length + 1);
      case '0xd894da4d': return word(-3n * E / 100n);
      case '0xf2a40db8': return a ? '0x' + [BigInt(owner), a.yang ? 1n : 0n, BigInt(a.enter), BigInt(a.exit), a.principal].map(v => word(v).slice(2)).join('') : '0x' + '0'.repeat(320);
      case '0xcadf338f': return word(a?.value ?? 0n); case '0xb68f590f': return word(a?.raw ?? 0n);
      case '0xa2e04c67': return '0x' + [0n, 0n, arg <= BigInt(folded) - 2n ? 1n : 0n].map(v => word(v).slice(2)).join('');
    }
    throw Error('unexpected selector ' + sel);
  };
  return {
    sends, read: async (to, data) => at(to, data),
    simulate: async (to, sig) => { if (sig.startsWith('sweep')) return String(surplus); return '0'; },
    send: async (to, sig, gas, ...args) => { sends.push([sig, ...args]); },
  };
}

test('vol tiers map K to annual vol', () => {
  assert.equal(annualVol(23n * E).toFixed(3), '0.050');
  assert.equal(annualVol(4_600_000_000_000_000_000n).toFixed(3), '0.250');
});

test('pool summary: matched, idle side, next epoch readiness', async () => {
  const p = await readPool(fixture().read, pool);
  assert.equal(p.matched_wad, (100n * E).toString());
  assert.equal(p.idleSide, 'yang');
  assert.equal(p.idle_wad, (50n * E).toString());
  assert.equal(p.nextEpoch, 1008);
  assert.equal(p.nextEpochReady, true);
  assert.equal(p.annualVol.toFixed(2), '0.10');
  assert.equal(p.lastS_wad, (-3n * E / 100n).toString());
  const waiting = await readPool(fixture({ folded: 1007 }).read, pool);
  assert.equal(waiting.nextEpochReady, false);
});

test('account view: status, value, multiple', async () => {
  const a = await readAccount(fixture().read, pool, 1);
  assert.equal(a.side, 'yang'); assert.equal(a.status, 'open'); assert.equal(a.multiple, 1.2);
  assert.equal(a.pnl_wad, (20n * E).toString());
  const entering = await readAccount(fixture({ folded: 1003 }).read, pool, 1);
  assert.equal(entering.status, 'entering');
  assert.equal((await readAccount(fixture().read, pool, 9)).closed, true);
});

test('keeper processes ready epochs, retires floored accounts, sweeps surplus', async () => {
  const f = fixture({
    accounts: {
      1: { yang: true, enter: 1002, exit: 0, principal: 100n * E, value: 0n, raw: -E },
      2: { yang: false, enter: 1002, exit: 0, principal: 100n * E, value: 200n * E, raw: 201n * E },
    }, surplus: 1n,
  });
  const r = await maintainPool({ ...f, pool });
  assert.deepEqual(f.sends.map(s => s.join(' ')), ['processMany(uint256) 8', 'retire(uint256) 1', 'sweep()']);
  assert.deepEqual(r.done, ['processMany', 'retire 1', 'sweep']);
});

test('keeper works with an index that has no frozen exit', async () => {
  const f = fixture();
  const read = async (to, data) => { if (to === index && data === '0x054f7d9c') throw Error('execution reverted'); return f.read(to, data); };
  await maintainPool({ ...f, read, pool });
  assert.deepEqual(f.sends.map(s => s[0]), ['processMany(uint256)']);
});

test('keeper does nothing when idle, and freezes after the index does', async () => {
  const idle = fixture({ folded: 1007 });
  await maintainPool({ ...idle, pool });
  assert.deepEqual(idle.sends, []);
  const frozen = fixture({ indexFrozen: true });
  await maintainPool({ ...frozen, pool });
  assert.deepEqual(frozen.sends.map(s => s[0]), ['freezePool(uint256)']);
  const done = fixture({ frozen: true, indexFrozen: true });
  await maintainPool({ ...done, pool });
  assert.deepEqual(done.sends, []);
});

test('relay-less pools: ready epochs are marked from headers, highest first, bridging gaps over 1024', async () => {
  const { markFromHeaders, maintainPool } = await import('./accounts.mjs');
  const run = async ({ queue, head = 0, folded, marked = [] }) => {
    const calls = [];
    const read = async (to, data) => {
      const sel = data.slice(0, 10), arg = data.length > 10 ? BigInt('0x' + data.slice(10, 74)) : 0n;
      if (to === index) return word(folded);
      if (sel === '0x8f7dcfa3') return word(head);
      if (sel === '0xab91c7b0') return word(queue.length);
      if (sel === '0xddf0b009') return word(queue[Number(arg)]);
      if (sel === '0x515f805e') return word(marked.includes(Number(arg)) ? 1 : 0);
      throw Error('unexpected ' + sel);
    };
    const headersFor = async (from, to) => '0x' + 'ab'.repeat(80 * (to - from + 1));
    const send = async (to, sig, gas, h, top, hex) => calls.push([Number(h), Number(top), (hex.length - 2) / 160]);
    await markFromHeaders({ read, simulate: async () => '0', send, pool, index, headersFor });
    return calls;
  };
  // 2000 is the tip (read from the index, no headers); 2010 is not folded yet.
  assert.deepEqual(await run({ queue: [500, 1000, 1990, 2000, 2010], folded: 2000 }),
    [[1990, 2000, 10], [1000, 1990, 990], [500, 1000, 500]]);
  // One epoch far below the tip: bridged in MAX_WALK steps, each anchored on the mark above it.
  assert.deepEqual(await run({ queue: [100], folded: 2500 }),
    [[1476, 2500, 1024], [452, 1476, 1024], [100, 452, 352]]);
  // Already marked heights are anchors, not work.
  assert.deepEqual(await run({ queue: [1000, 1990], folded: 2000, marked: [1990] }), [[1000, 1990, 990]]);

  // maintainPool asks for a header source rather than sending processMany that could not progress.
  const f = fixture({ queue: [1008], folded: 1010 });
  const read = async (to, data) => (to === pool && data === '0x59cfd7b0' ? word(0) : f.read(to, data));
  const logs = [];
  await maintainPool({ ...f, read, pool, log: (...a) => logs.push(a.join(' ')) });
  assert.deepEqual(f.sends, []);
  assert.match(logs.join('\n'), /no header source/);
});

test('a pool whose pricing view reverts (index tip too old for A) is still read and maintained', async () => {
  const f = fixture();
  const read = async (to, data) => { if (to === pool && data === '0x7dd7307d') throw Error('execution reverted: index stale'); return f.read(to, data); };
  const p = await readPool(read, pool);
  assert.equal(p.nextPricingHeight, null);
  assert.equal(p.nextEpochReady, true);
  await maintainPool({ ...f, read, pool });
  assert.deepEqual(f.sends.map(s => s[0]), ['processMany(uint256)']);
});
