// WUJI ZK keeper — advances ZkWujiIndex with one Groth16 proof per batch of Bitcoin headers.
//
//   RPC=... CHAIN_ID=... ZK_INDEX=<ZkWujiIndex> KEYSTORE_ACCOUNT=... PASSWORD_FILE=... node indexer/zk-keeper.mjs
//
// Each round: read the contract's continuity(), fetch the next headers from the Bitcoin source, and once
// a batch is worth proving (ZK_MIN_BATCH headers, or ZK_MAX_WAIT_MIN minutes since the tip last moved)
// run the SP1 host (`zk/script prove-input`), then submit foldProof. If proving fails, fall back to
// foldHeaders with the same headers so the index never depends on a prover (ZK_FALLBACK=0 disables).
// Signs with `cast` and an encrypted keystore; never handles a key. On anvil only (chain 31337),
// ZK_UNLOCKED_FROM=<address> signs with anvil's unlocked account instead.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpcRequest } from './evm-rpc.mjs';
import { assertChain } from './networks.mjs';
import { createBitcoinSource } from './bitcoin-source.mjs';
import { step } from './bitcoin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const RPC = (env.RPC || '').split(',')[0];
const CHAIN_ID = Number(env.CHAIN_ID || 0);
const INDEX = (env.ZK_INDEX || '').toLowerCase();
const MIN_BATCH = Number(env.ZK_MIN_BATCH || 42);          // 36 folded heights + 6 confirmations ≈ 6 hours
const MAX_BATCH = Number(env.ZK_MAX_BATCH || 1008);        // ≈ 1 week; proving time and memory grow linearly
const MAX_WAIT_MIN = Number(env.ZK_MAX_WAIT_MIN || 720);   // prove a smaller batch rather than let the tip age
const INTERVAL = Number(env.INTERVAL || 120);
const FALLBACK = env.ZK_FALLBACK !== '0';
const HOST = env.ZK_HOST || path.join(root, 'zk/script/target/release/wuji-zk-script');
const CAST = env.CAST || path.join(os.homedir(), '.foundry/bin/cast');
const WORK = env.ZK_WORK_DIR || path.join(root, 'indexer/data/zk');
if (!RPC || !CHAIN_ID || !/^0x[0-9a-f]{40}$/.test(INDEX)) throw Error('need RPC, CHAIN_ID and ZK_INDEX');
const UNLOCKED = env.ZK_UNLOCKED_FROM;
if (UNLOCKED && CHAIN_ID !== 31337) throw Error('ZK_UNLOCKED_FROM is for anvil (chain 31337) only');
if (!UNLOCKED && (!env.KEYSTORE_ACCOUNT || !env.PASSWORD_FILE)) throw Error('need KEYSTORE_ACCOUNT and PASSWORD_FILE');
fs.mkdirSync(WORK, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const rpc = (m, p) => rpcRequest(RPC, m, p);
const call = async (data) => rpc('eth_call', [{ to: INDEX, data }, 'latest']);
const word = (hex, i) => BigInt('0x' + hex.slice(2 + 64 * i, 66 + 64 * i));
const signed = v => (v >= 1n << 255n ? v - (1n << 256n) : v);
const sel = sig => execFileSync(CAST, ['sig', sig], { encoding: 'utf8' }).trim();

/// continuity() returns (Continuity{hash,height,bits,time,epochStart,u}, uint32[11], uint256 work): 18 words.
export function decodeContinuity(hex) {
  if (!/^0x[0-9a-f]{1152}$/i.test(hex)) throw Error('unexpected continuity() encoding');
  return {
    hash: '0x' + hex.slice(2, 66),
    height: Number(word(hex, 1)), bits: Number(word(hex, 2)), time: Number(word(hex, 3)),
    epochStart: Number(word(hex, 4)), u: signed(word(hex, 5)).toString(),
    recentTimes: Array.from({ length: 11 }, (_, i) => Number(word(hex, 6 + i))),
    work: '0x' + hex.slice(2 + 64 * 17, 66 + 64 * 17),
  };
}

async function send(sig, gas, ...args) {
  assertChain(await rpc('eth_chainId', []), CHAIN_ID);
  const who = UNLOCKED ? ['--unlocked', '--from', UNLOCKED] : ['--account', env.KEYSTORE_ACCOUNT, '--password-file', env.PASSWORD_FILE];
  const price = env.KEEPER_GAS_PRICE ? ['--legacy', '--gas-price', env.KEEPER_GAS_PRICE] : [];
  const out = await new Promise((resolve, reject) => execFile(CAST, ['send', INDEX, sig, ...args, '--rpc-url', RPC, '--chain', String(CHAIN_ID),
    '--gas-limit', String(gas), ...who, ...price, '--json'], { maxBuffer: 64 << 20 }, (e, so, se) => e ? reject(Error(String(se || e.message).split('\n').find(Boolean))) : resolve(so)));
  const r = JSON.parse(out);
  if (r.status !== '0x1' && r.status !== 1) throw Error(sig.split('(')[0] + ' reverted ' + r.transactionHash);
  return { hash: r.transactionHash, gas: parseInt(r.gasUsed, 16) };
}

function prove(inputFile, outFile) {
  return new Promise((resolve, reject) => execFile(HOST, ['prove-input', '--input', inputFile, '--out', outFile, '--mode', 'groth16'],
    { maxBuffer: 64 << 20, timeout: 3 * 3600_000, env: { ...env, RUST_LOG: env.RUST_LOG || 'warn' } },
    (e, so, se) => e ? reject(Error('prover: ' + String(se || e.message).trim().split('\n').slice(-1)[0])) : resolve(JSON.parse(fs.readFileSync(outFile, 'utf8')))));
}

let immut, lastProgress = Date.now(), lastHeight = -1;
export async function round(source) {
  assertChain(await rpc('eth_chainId', []), CHAIN_ID);
  immut ||= {
    genesis: Number(BigInt(await call(sel('GENESIS_HEIGHT()')))),
    interval: Number(BigInt(await call(sel('CHECKPOINT_INTERVAL()')))),
    confirmations: Number(BigInt(await call(sel('CONFIRMATIONS()')))),
    maxHeaders: Number(BigInt(await call(sel('MAX_HEADERS()')))),
  };
  const start = decodeContinuity(await call(sel('continuity()')));
  if (start.height !== lastHeight) { lastHeight = start.height; lastProgress = Date.now(); }
  const tip = await source.tip();
  const available = tip - start.height;
  const waited = (Date.now() - lastProgress) / 60_000;
  if (available <= immut.confirmations || (available < MIN_BATCH && waited < MAX_WAIT_MIN)) {
    return { action: 'wait', height: start.height, available };
  }
  const count = Math.min(available, MAX_BATCH);
  const headers = [];
  let prev = start.hash.slice(2);
  for (let h = start.height + 1; h <= start.height + count; h++) {
    const b = await source.at(h);
    const s = step(b.header);
    if (b.header.slice(8, 72) !== prev) throw Error(`header ${h} does not link to ${h - 1}; source may be on another branch`);
    if (s.hash !== b.hash) throw Error(`source hash mismatch at ${h}`);
    headers.push(b.header); prev = s.internalHash;
  }
  const input = {
    start, headers: '0x' + headers.join(''),
    // The contract accepts maxTime ≤ its block time + 2h; 90 minutes ahead leaves room for proving and inclusion.
    maxTime: Math.floor(Date.now() / 1000) + 90 * 60,
    genesisHeight: immut.genesis, checkpointInterval: immut.interval, confirmations: immut.confirmations,
  };
  const tag = `${start.height + 1}-${start.height + count}`;
  const inFile = path.join(WORK, `input-${tag}.json`), outFile = path.join(WORK, `proof-${tag}.json`);
  fs.writeFileSync(inFile, JSON.stringify(input));
  log(`proving ${count} headers ${tag}`);
  try {
    const p = await prove(inFile, outFile);
    log(`proved in ${p.seconds.toFixed(0)} s, folds to ${p.newHeight}`);
    const tx = await send('foldProof(bytes,bytes,address[])', 1_500_000, p.proof, p.journal, '[]');
    log(`foldProof ${tag} gas ${tx.gas} ${tx.hash}`);
    return { action: 'proof', ...tx, headers: count, newHeight: p.newHeight };
  } catch (e) {
    log('proof path failed:', e.message);
    if (!FALLBACK) throw e;
    const n = Math.min(count, immut.maxHeaders);
    const tx = await send('foldHeaders(bytes,address[])', 60_000_000, '0x' + headers.slice(0, n).join(''), '[]');
    log(`fallback foldHeaders ${n} headers gas ${tx.gas} ${tx.hash}`);
    return { action: 'headers', ...tx, headers: n };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = env.ZK_FIXTURE_SOURCE ? fixtureSource(env.ZK_FIXTURE_SOURCE) : createBitcoinSource();
  log(`zk keeper on ${INDEX} (chain ${CHAIN_ID}); batch ${MIN_BATCH}..${MAX_BATCH}, max wait ${MAX_WAIT_MIN} min, fallback ${FALLBACK}`);
  for (;;) {
    try { const r = await round(source); if (r.action === 'wait') log(`waiting: ${r.available} headers past ${r.height}`); }
    catch (e) { log('error:', e.message); }
    if (env.ZK_ONCE) break;
    await new Promise(r => setTimeout(r, INTERVAL * 1000));
  }
}

/// Test-only Bitcoin source backed by the committed mainnet fixture (heights checkpoint+1 ...).
function fixtureSource(count) {
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'contracts/test/fixtures/bitcoin-timestamps.json'), 'utf8'));
  const hex = fs.readFileSync(path.join(root, 'contracts/test/fixtures/bitcoin-timestamps.hex'), 'utf8').trim().replace(/^0x/, '');
  const first = meta.checkpointHeight + 1, n = Math.min(Number(count), hex.length / 160);
  return {
    tip: async () => first + n - 1,
    at: async h => { const header = hex.slice((h - first) * 160, (h - first + 1) * 160); return { height: h, header, hash: step(header).hash }; },
  };
}
