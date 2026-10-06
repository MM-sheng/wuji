#!/usr/bin/env node
// Seal drill (T13 rule 3, end to end on a throwaway anvil chain): the production keeper code folds a mined
// Bitcoin-like chain into the index, a pool takes real entries, then the chain reorganizes past the finalized tip
// and the keeper itself notices, waits while the branch is too light, seals the index once it is heavy enough,
// freezes the pool, and every account is paid out. Uses the test-only EasyHeaderIndex (regtest difficulty, so
// blocks can be mined here); everything else is the code that runs on Sepolia and mainnet.
//
//   node scripts/seal-drill.mjs          # needs Foundry (anvil, cast, forge) and `forge build` in contracts/
//
// No key is handled: anvil's own unlocked accounts sign.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { sha256d } from '../indexer/bitcoin.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bin = n => process.env[n.toUpperCase()] || path.join(os.homedir(), '.foundry/bin', n);
const PORT = 8611, RPC = `http://127.0.0.1:${PORT}`;
const [KEEPER, ALICE, BOB, CAROL] = ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', '0x90F79bf6EB2c4f870365E785982E1f101E93b906'];
const K = 100, ANCHOR = 100, BITS = 0x207fffff, TARGET = 0x7fffffn << 232n;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wuji-seal-drill-'));
const chainFile = path.join(work, 'chain.json');
const log = (...a) => console.log('·', ...a);

// ---------------------------------------------------------------- a mined chain
const now = Math.floor(Date.now() / 1000);
const timeOf = h => now + 120 + 600 * (h - 400); // height 400 is "now"; later heights lie ahead, released by moving time
function mine(prev, time, salt) {
  const h = Buffer.alloc(80);
  h.writeInt32LE(4, 0); Buffer.from(prev, 'hex').copy(h, 4); h.writeUInt32LE(salt >>> 0, 36);
  h.writeUInt32LE(time, 68); h.writeUInt32LE(BITS, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt('0x' + Buffer.from(sha256d(h)).reverse().toString('hex')) <= TARGET) return h.toString('hex');
  }
}
const hashOf = hex => sha256d(Buffer.from(hex, 'hex')).toString('hex');
function extend(headers, first, to, salt) {
  const out = [...headers];
  for (let h = first + out.length; h <= to; h++) out.push(mine(out.length ? hashOf(out.at(-1)) : '00'.repeat(32), timeOf(h), salt * 1e6 + h));
  return out;
}
const FIRST = ANCHOR - 10;
let main = extend([], FIRST, 900, 1);
const release = (headers, to) => fs.writeFileSync(chainFile, JSON.stringify({ first: FIRST, headers: headers.slice(0, to - FIRST + 1) }));

// ---------------------------------------------------------------- anvil and contracts
const anvil = spawn(bin('anvil'), ['--port', String(PORT), '--silent', '--code-size-limit', '100000'], { stdio: 'ignore' });
const cast = (...a) => execFileSync(bin('cast'), a, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const rpc = async (method, params = []) => {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw Error(r.error.message); return r.result;
};
const setTime = async t => { await rpc('evm_setNextBlockTimestamp', [t]); await rpc('evm_mine'); };
const artifact = (file, name) => JSON.parse(fs.readFileSync(path.join(root, 'contracts/out', file, name + '.json'), 'utf8')).bytecode.object;
const create = (code, from = KEEPER) => JSON.parse(cast('send', '--unlocked', '--from', from, '--rpc-url', RPC, '--json', '--create', code)).contractAddress;
const send = (from, to, sig, ...args) => {
  const r = JSON.parse(cast('send', to, sig, ...args, '--unlocked', '--from', from, '--rpc-url', RPC, '--json'));
  assert.equal(r.status, '0x1', sig); return r;
};
const read = (to, sig, ...args) => cast('call', to, sig, ...args, '--rpc-url', RPC).split(' ')[0];

try {
  for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 50) throw Error('anvil did not start'); await new Promise(r => setTimeout(r, 100)); } }
  release(main, 400);
  await setTime(timeOf(400) + 60);

  const times = `[${Array.from({ length: 11 }, (_, i) => timeOf(FIRST + i)).join(',')}]`;
  const idxArgs = cast('abi-encode', 'f(bytes,uint64,uint32[11],uint64)', '0x' + main[ANCHOR - FIRST], String(ANCHOR), times, String(K));
  const INDEX = create(artifact('WujiHeaderIndex.reorg.t.sol', 'EasyHeaderIndex') + idxArgs.slice(2));
  const USDT = create(artifact('MockUSDT.sol', 'MockUSDT'));
  const cfg = `(${USDT},${INDEX},11500000000000000000,6,2,1800,0x000000000000000000000000000000000000fEE0,0,0,1000,1000000000000000000000,0)`;
  const POOL = create(artifact('WujiAccounts.sol', 'WujiAccounts') + cast('abi-encode', 'f((address,address,int256,uint64,uint64,uint256,address,uint256,uint256,uint256,uint256,uint64))', cfg).slice(2));
  log('index', INDEX, 'pool', POOL);

  // The production keeper, configured as on Sepolia but signing with anvil's unlocked account.
  Object.assign(process.env, { RPC, CHAIN_ID: '31337', ZK_INDEX: INDEX.toLowerCase(), ZK_UNLOCKED_FROM: KEEPER, ZK_WORK_DIR: work,
    ZK_MIN_FOLD: '1', ACCOUNTS: POOL.toLowerCase() });
  const keeper = await import('../indexer/zk-keeper.mjs');
  const source = keeper.fixtureFile(chainFile);
  const tick = async () => { const r = await keeper.round(source); await keeper.maintainAccounts(source, [POOL.toLowerCase()]); return r; };

  // 1. Fold the chain; the keeper records each finalized state it sees.
  assert.equal((await tick()).action, 'headers');
  log('folded to', read(INDEX, 'lastHeight()(uint64)'), 'seen', read(INDEX, 'seenHeight()(uint64)'));

  // 2. Alice and Bob enter; the chain grows until their epoch is folded and processed.
  for (const [who, yang, amount] of [[ALICE, 'true', '100'], [BOB, 'false', '60']]) {
    send(KEEPER, USDT, 'mint(address,uint256)', who, amount + 'e18');
    send(who, USDT, 'approve(address,uint256)', POOL, amount + 'e18');
    send(who, POOL, 'requestEnter(bool,uint128)', yang, amount + 'e18');
  }
  const priced = Number(read(POOL, 'nextPricingHeight()(uint64)'));
  log('Alice and Bob entered, priced near', priced);
  for (let to = 420; to <= 900; to += 20) {
    release(main, to); await setTime(timeOf(to) + 60); await tick();
    if (read(POOL, 'valueOf(uint256)(uint256)', '1') !== '0' && read(POOL, 'valueOf(uint256)(uint256)', '2') !== '0') break;
  }
  const valueAlice = BigInt(read(POOL, 'valueOf(uint256)(uint256)', '1')), valueBob = BigInt(read(POOL, 'valueOf(uint256)(uint256)', '2'));
  assert.ok(valueAlice > 0n && valueBob > 0n, 'entries processed');
  await tick(); // one more round records the latest finalized state
  const tipHeight = Number(read(INDEX, 'lastHeight()(uint64)')), seen = Number(read(INDEX, 'seenHeight()(uint64)'));
  log('entries processed; finalized', tipHeight, 'seen', seen, 'S', read(INDEX, 'S()(int256)'));

  // 3. Carol enters after that: priced above the finalized tip, so she can only be refunded.
  send(KEEPER, USDT, 'mint(address,uint256)', CAROL, '50e18');
  send(CAROL, USDT, 'approve(address,uint256)', POOL, '50e18');
  send(CAROL, POOL, 'requestEnter(bool,uint128)', 'true', '50e18');

  // 4. Bitcoin reorganizes 30 blocks below the finalized tip. First the new branch is too light.
  const fork = tipHeight - 30;
  const branch = extend(main.slice(0, fork - FIRST + 1), FIRST, seen + 400, 2);
  release(branch, seen + 20); await setTime(timeOf(seen + 20) + 60);
  const waiting = await tick();
  assert.equal(waiting.action, 'reorg-wait'); assert.equal(read(INDEX, 'frozen()(bool)'), 'false');
  log(`branch from ${fork} to ${seen + 20}: keeper waits (${waiting.reason})`);

  // 5. The branch outgrows the finalized chain by K + 144 blocks: the keeper seals, then freezes the pool.
  release(branch, seen + 400); await setTime(timeOf(seen + 400) + 60);
  const sealed = await tick();
  assert.equal(sealed.action, 'sealed'); assert.equal(read(INDEX, 'frozen()(bool)'), 'true');
  assert.equal(read(POOL, 'frozen()(bool)'), 'true', 'pool frozen in the same round');
  log(`sealed: ${sealed.headers} headers, gas ${sealed.gas}; pool frozen`);
  assert.equal((await tick()).action, 'frozen');
  assert.throws(() => cast('call', INDEX, 'foldHeaders(bytes,address[])', '0x' + branch.slice(0, 101).join(''), '[]', '--rpc-url', RPC), /IndexFrozen|revert/);
  assert.equal(read(INDEX, 'lastHeight()(uint64)'), String(tipHeight), 'nothing advanced');

  // 6. Everyone exits: Alice and Bob at the last recorded S (the frozen pool's values), Carol refunded in full.
  const frozenAlice = BigInt(read(POOL, 'valueOf(uint256)(uint256)', '1')), frozenBob = BigInt(read(POOL, 'valueOf(uint256)(uint256)', '2'));
  for (const [who, id] of [[ALICE, '1'], [BOB, '2'], [CAROL, '3']]) send(who, POOL, 'claim(uint256)', id);
  const bal = who => BigInt(read(USDT, 'balanceOf(address)(uint256)', who));
  const paid = { alice: bal(ALICE), bob: bal(BOB), carol: bal(CAROL) };
  assert.equal(paid.carol, 50n * 10n ** 18n, 'Carol refunded in full');
  assert.equal(paid.alice, frozenAlice, 'Alice paid her value at the last recorded S');
  assert.equal(paid.bob, frozenBob, 'Bob paid his value at the last recorded S');
  assert.ok(paid.alice + paid.bob <= 160n * 10n ** 18n, 'never more than was deposited');
  const result = { fork, finalizedTip: tipHeight, frozenS: read(INDEX, 'S()(int256)'), valuesWhenProcessed: [valueAlice, valueBob].map(v => (Number(v) / 1e18).toFixed(6)), sealHeaders: sealed.headers, sealGas: sealed.gas,
    paid: Object.fromEntries(Object.entries(paid).map(([k, v]) => [k, (Number(v) / 1e18).toFixed(6)])), poolLeft: (Number(bal(POOL)) / 1e18).toFixed(6) };
  console.log('SEAL DRILL PASSED', JSON.stringify(result));
} finally {
  anvil.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
