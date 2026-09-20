import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverGaps } from './gap-sync.mjs';

test('skips empty history, finds separated events and multiple gaps in one block', async () => {
  const events = new Map([[100, [[10, 29], [40, 49]]], [900, [[200, 299]]]]);
  const counter = async b => (b >= 100 ? 30 : 0) + (b >= 900 ? 100 : 0);
  const reads = [], commits = [];
  await discoverGaps(1, 1000, counter, async b => { reads.push(b); return events.get(b); }, (g, b) => commits.push([g, b]));
  assert.deepEqual(reads, [100, 900]);
  assert.deepEqual(commits, [[events.get(100), 100], [events.get(900), 900], [[], 1000]]);
});
test('resume does not replay already committed gaps', async () => {
  const commits = [];
  await discoverGaps(101, 800, async () => 30, () => { throw Error('must not query logs'); }, (g, b) => commits.push([g, b]));
  assert.deepEqual(commits, [[[], 800]]);
});
test('missing event evidence cannot advance the cursor', async () => {
  let committed = false;
  await assert.rejects(discoverGaps(1, 100, async b => b >= 50 ? 20 : 0, async () => [], () => { committed = true; }), /incomplete/);
  assert.equal(committed, false);
});
test('failed later query preserves the last successful commit', async () => {
  const commits = [];
  await assert.rejects(discoverGaps(1, 100, async b => (b >= 40 ? 10 : 0) + (b >= 90 ? 10 : 0), async b => {
    if (b === 90) throw Error('RPC unavailable');
    return [[1, 10]];
  }, (g, b) => commits.push(b)), /RPC unavailable/);
  assert.deepEqual(commits, [40]);
});

test('freezing removes only missing increments, preserving the later path exactly', async () => {
  const { freezeRange } = await import('./gap-sync.mjs');
  const values = Float64Array.from([3, 1, 8, 12, 10, 15]);
  assert.equal(freezeRange(values, 6, 100, 101, 103), 9);
  assert.deepEqual([...values], [3, 3, 3, 3, 1, 6]);
  assert.equal(freezeRange(values, 6, 100, 101, 103), 0);
  assert.equal(freezeRange(values, 6, 100, 105, 110), 5);
  assert.deepEqual([...values], [3, 3, 3, 3, 1, 1]);
});
