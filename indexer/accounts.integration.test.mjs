// Reads a real WujiAccounts pool on a throwaway anvil chain, so the ABI offsets in accounts.mjs are
// checked against the compiled contract rather than against a hand-written fixture.
// Skips when Foundry is not installed. Uses anvil's unlocked account: no key is ever handled.
import test from 'node:test'; import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { readPool, readAccount, maintainPool } from './accounts.mjs';

const bin = n => path.join(os.homedir(), '.foundry', 'bin', n);
const have = fs.existsSync(bin('anvil')) && fs.existsSync(bin('forge'));
const contracts = new URL('../contracts', import.meta.url).pathname;
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // anvil account 0, unlocked

test('accounts reader and keeper against the compiled contract', { skip: !have && 'foundry not installed', timeout: 180_000 }, async () => {
  const port = 18545 + Math.floor(Math.random() * 1000), url = `http://127.0.0.1:${port}`;
  const anvil = spawn(bin('anvil'), ['--port', String(port), '--silent', '--auto-impersonate', '--code-size-limit', '100000'], { stdio: 'ignore' });
  try {
    const rpc = async (method, params) => {
      const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      if (r.error) throw Error(r.error.message); return r.result;
    };
    for (let i = 0; ; i++) { try { await rpc('eth_chainId', []); break; } catch { if (i > 50) throw Error('anvil did not start'); await new Promise(r => setTimeout(r, 100)); } }
    const out = execFileSync(bin('forge'), ['script', 'script/AccountsFixture.s.sol', '--rpc-url', url, '--broadcast', '--unlocked', '--sender', SENDER, '--slow'],
      { cwd: contracts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const pool = out.match(/POOL (0x[0-9a-fA-F]{40})/)[1].toLowerCase();
    const read = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

    const p = await readPool(read, pool);
    const E = 10n ** 18n, net = a => a - (a * 30n + 9999n) / 10000n;
    assert.equal(p.yang_wad, net(100n * E).toString());
    assert.equal(p.yin_wad, net(60n * E).toString());
    assert.equal(p.matched_wad, net(60n * E).toString());
    assert.equal(p.idleSide, 'yang');
    assert.equal(p.pendingEpochs, 1);
    assert.equal(p.feeBps, 30); assert.equal(p.epoch, 6); assert.equal(p.annualVol.toFixed(2), '0.10');

    const a = await readAccount(read, pool, 1);
    assert.equal(a.owner, SENDER.toLowerCase()); assert.equal(a.side, 'yang'); assert.equal(a.status, 'open');
    assert.equal(a.principal_wad, net(100n * E).toString());
    const pending = await readAccount(read, pool, 3);
    assert.equal(pending.side, 'yin'); assert.equal(pending.status, 'entering');

    // Nothing is ready: the keeper must not send.
    const sends = [];
    await maintainPool({ read, pool, simulate: async () => '0', send: async (...s) => sends.push(s) });
    assert.deepEqual(sends, []);
  } finally { anvil.kill(); }
});
