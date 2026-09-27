// T11 perpetual-account pools: a dependency-free reader (indexer, terminal) and keeper duties.
// `read(to, data)` MUST pin every call to one EVM block; callers check that block's hash afterward.
// The contract is the authority; everything here is recomputable from it.

const SEL = {
  K: '0xa932492f', EPOCH: '0xa0dc2758', DELAY: '0x69b41170', FEE_BPS: '0xbf333f2c', asset: '0x38d52e0f',
  index: '0x2986c0e5', principalOf: '0x908de6c2', buffer: '0xedaafe20', badDebt: '0xbbcac557',
  head: '0x8f7dcfa3', queueLength: '0xab91c7b0', queue: '0xddf0b009', nextPricingHeight: '0x7dd7307d',
  frozen: '0x054f7d9c', nextId: '0x61b8ce8c', valueOf: '0xcadf338f', rawValueOf: '0xb68f590f',
  lastS: '0xd894da4d', accounts: '0xf2a40db8', epochAcc: '0xa2e04c67', lastHeight: '0x25159aa9',
  balanceOf: '0x70a08231',
};
const word = n => BigInt(n).toString(16).padStart(64, '0');
const addr = a => a.slice(2).toLowerCase().padStart(64, '0');
const uint = v => { if (!/^0x[0-9a-f]{64,}$/i.test(v)) throw Error('Invalid accounts ABI'); return BigInt(v.slice(0, 66)); };
const int = v => { const x = uint(v); return x >= 1n << 255n ? x - (1n << 256n) : x; };
const WAD = 10n ** 18n;
// Annual vol of S is ≈115%; a pool with sensitivity K moves ≈115%/K per year.
export const annualVol = k => 1.15 / (Number(k) / 1e18);

export async function readPool(read, pool) {
  const [k, epoch, delay, fee, asset, index, yin, yang, buffer, badDebt, head, qlen, next, frozen, nextId, lastS] =
    await Promise.all([
      read(pool, SEL.K), read(pool, SEL.EPOCH), read(pool, SEL.DELAY), read(pool, SEL.FEE_BPS), read(pool, SEL.asset),
      read(pool, SEL.index), read(pool, SEL.principalOf + word(0)), read(pool, SEL.principalOf + word(1)),
      read(pool, SEL.buffer), read(pool, SEL.badDebt), read(pool, SEL.head), read(pool, SEL.queueLength),
      read(pool, SEL.nextPricingHeight), read(pool, SEL.frozen), read(pool, SEL.nextId), read(pool, SEL.lastS),
    ]);
  const assetAddr = '0x' + asset.slice(-40), indexAddr = '0x' + index.slice(-40);
  const [balance, folded] = await Promise.all([read(assetAddr, SEL.balanceOf + addr(pool)), read(indexAddr, SEL.lastHeight)]);
  const P = [uint(yin), uint(yang)], matched = P[0] < P[1] ? P[0] : P[1];
  const h = uint(head), n = uint(qlen);
  const nextEpoch = h < n ? uint(await read(pool, SEL.queue + word(h))) : null;
  return {
    address: pool, asset: assetAddr, index: indexAddr,
    k_wad: int(k).toString(), annualVol: annualVol(int(k)),
    epoch: Number(uint(epoch)), delay: Number(uint(delay)), feeBps: Number(uint(fee)),
    yin_wad: P[0].toString(), yang_wad: P[1].toString(), matched_wad: matched.toString(),
    idleSide: P[0] === P[1] ? null : P[0] > P[1] ? 'yin' : 'yang', idle_wad: (P[0] > P[1] ? P[0] - P[1] : P[1] - P[0]).toString(),
    buffer_wad: uint(buffer).toString(), badDebt_wad: uint(badDebt).toString(), balance_wad: uint(balance).toString(),
    pendingEpochs: Number(n - h), nextEpoch: nextEpoch === null ? null : Number(nextEpoch),
    nextEpochReady: nextEpoch !== null && nextEpoch <= uint(folded),
    nextPricingHeight: Number(uint(next)), lastS_wad: int(lastS).toString(),
    frozen: uint(frozen) === 1n, accountsCreated: Number(uint(nextId) - 1n),
  };
}

/// One account, as its owner would see it.
export async function readAccount(read, pool, id) {
  const [raw, value, rawValue] = await Promise.all([
    read(pool, SEL.accounts + word(id)), read(pool, SEL.valueOf + word(id)), read(pool, SEL.rawValueOf + word(id)),
  ]);
  const w = i => '0x' + raw.slice(2 + 64 * i, 66 + 64 * i);
  const owner = '0x' + w(0).slice(-40);
  if (/^0x0{40}$/.test(owner)) return { id, closed: true };
  const enterEpoch = uint(w(2)), exitEpoch = uint(w(3)), principal = uint(w(4));
  const [entered, exited] = await Promise.all([
    read(pool, SEL.epochAcc + word(enterEpoch)), exitEpoch ? read(pool, SEL.epochAcc + word(exitEpoch)) : null,
  ]);
  const processed = v => v !== null && uint('0x' + v.slice(130, 194)) === 1n;
  const v = uint(value);
  return {
    id, owner, side: uint(w(1)) === 1n ? 'yang' : 'yin', principal_wad: principal.toString(),
    enterEpoch: Number(enterEpoch), exitEpoch: exitEpoch ? Number(exitEpoch) : null,
    status: !processed(entered) ? 'entering' : exitEpoch && !processed(exited) ? 'exiting' : exitEpoch ? 'claimable' : 'open',
    value_wad: v.toString(), pnl_wad: (v - (processed(entered) ? principal : v)).toString(),
    atFloor: processed(entered) && v === 0n, overshoot_wad: (int(rawValue) < 0n ? -int(rawValue) : 0n).toString(),
    multiple: principal ? Number(v * 10000n / principal) / 10000 : 0,
  };
}

/// Keeper duties for one pool, all permissionless and all paid from the pool's buffer:
/// process ready epochs, retire accounts at the floor, sweep buffer surplus, and freeze after the index does.
/// `simulate(to, sig, ...args)` must throw on revert; `send(to, sig, gas, ...args)` signs.
export async function maintainPool({ read, simulate, send, pool, cursor = 1, scan = 200, log = () => {} }) {
  const state = await readPool(read, pool);
  const done = [];
  if (state.frozen) return { state, done, cursor };
  // Older indexes have no frozen exit (the call reverts); for them the pool can never freeze.
  const indexFrozen = await read(state.index, SEL.frozen).then(v => uint(v) === 1n, () => false);
  if (indexFrozen) {
    await send(pool, 'freezePool(uint256)', 3_000_000, '50'); done.push('freezePool');
    return { state, done, cursor };
  }
  if (state.nextEpochReady) {
    // Ceiling, not a reservation: a catch-up chunk after a long absence walks 1024 heights (≈5.5M gas).
    await send(pool, 'processMany(uint256)', 8_000_000, '8'); done.push('processMany');
  }
  // Retirement: scan a window of ids per round so cost stays bounded as the pool grows.
  const last = state.accountsCreated;
  let id = cursor > last ? 1 : cursor;
  for (let i = 0; i < Math.min(scan, last); i++, id = id >= last ? 1 : id + 1) {
    const a = await readAccount(read, pool, id);
    if (!a.closed && a.status === 'open' && a.atFloor) {
      try { await simulate(pool, 'retire(uint256)', String(id)); } catch { continue; }
      await send(pool, 'retire(uint256)', 400_000, String(id)); done.push('retire ' + id);
      log('retired account', id, 'overshoot', a.overshoot_wad);
    }
  }
  try {
    const surplus = BigInt(String(await simulate(pool, 'sweep()(uint256)')).split(' ')[0]);
    if (surplus > 0n) { await send(pool, 'sweep()', 200_000); done.push('sweep'); }
  } catch { /* nothing to sweep */ }
  return { state, done, cursor: id };
}

export const formatWad = v => (Number(BigInt(v) * 10000n / WAD) / 10000).toString();
