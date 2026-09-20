// frozenBlocks is monotone: equal endpoint counters prove no Gap occurred in between.
// Locate only blocks that changed it, avoiding pruned/range-limited eth_getLogs scans.
export async function discoverGaps(from, to, counterAt, logsAt, accept) {
  let cursor = from, before = await counterAt(from - 1);
  const end = await counterAt(to);
  if (end < before) throw new Error('frozen counter decreased');
  while (before < end) {
    let lo = cursor, hi = to;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await counterAt(mid) > before) hi = mid;
      else lo = mid + 1;
    }
    const after = await counterAt(lo);
    const gaps = await logsAt(lo);
    let count = 0;
    for (const [a, b] of gaps) {
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < a || b >= lo) throw new Error('invalid Gap interval');
      count += b - a + 1;
    }
    if (count !== after - before) throw new Error(`Gap logs incomplete at #${lo}`);
    await accept(gaps, lo);
    before = after; cursor = lo + 1;
  }
  await accept([], to);
}

export function freezeRange(values, length, genesis, from, to) {
  const first = Math.max(0, from - genesis), last = Math.min(length - 1, to - genesis);
  if (last < first) return 0;
  const base = first > 0 ? values[first - 1] : 0, removed = values[last] - base;
  for (let i = first; i <= last; i++) values[i] = base;
  for (let i = last + 1; i < length; i++) values[i] -= removed;
  return removed;
}
