import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

/// Drive the watchdog against a fake /head and assert it says the right thing.
async function run(payload, { keeperLog = '/dev/null', extraEnv = {} } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const child = spawn(process.execPath, [
    'scripts/watchdog.mjs', '--url', `http://127.0.0.1:${port}`,
    '--interval', '1', '--keeper-log', keeperLog,
  ], { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  await new Promise(resolve => setTimeout(resolve, 900));
  child.kill();
  server.close();
  return out;
}

test('reports a healthy stack without alerting', async () => {
  const out = await run({ height: 100, chainHead: 103, chain: { lastHeight: 100, agree: true, vaults: [] } });
  assert.match(out, /behind 3/);
  assert.doesNotMatch(out, /ALERT/);
});

test('alerts when the contract and the local recomputation disagree', async () => {
  const out = await run({
    height: 100, chainHead: 102,
    chain: { lastHeight: 100, agree: false, S_wad: '1', indexer_S_wad: '2', vaults: [] },
  });
  assert.match(out, /ALERT.*contract S 1 != indexer S 2/);
});

test('alerts when the indexer falls behind or halts', async () => {
  const behind = await run({ height: 100, chainHead: 400, chain: { agree: true, vaults: [] } });
  assert.match(behind, /ALERT.*300 Bitcoin heights behind/);
  const halted = await run({ height: 100, chainHead: 101, halted: true, chain: { agree: true, vaults: [] } });
  assert.match(halted, /ALERT.*deep reorg/);
});

test('alerts when a vault cannot cover its liabilities or is overdue', async () => {
  const out = await run({
    height: 100, chainHead: 900,
    chain: { agree: true, vaults: [{ address: '0x1', symbol: 'USDT', balance: 1, liabilities: 2, settlementHeight: 500, settled: false }] },
  });
  assert.match(out, /ALERT.*balance 1 < liabilities 2/);
  assert.match(out, /ALERT.*past its settlement height/);
});

test('an unreachable indexer with no --start is reported, not silently retried', async () => {
  const child = spawn(process.execPath, [
    'scripts/watchdog.mjs', '--url', 'http://127.0.0.1:1', '--interval', '1', '--keeper-log', '/dev/null',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  await new Promise(resolve => setTimeout(resolve, 1200));
  child.kill();
  assert.match(out, /ALERT.*indexer unreachable/);
  assert.match(out, /not restarting/);
});
