// WUJI ZK keeper — advances ZkWujiIndex with one Groth16 proof per batch of Bitcoin headers.
//
//   RPC=... CHAIN_ID=... ZK_INDEX=<ZkWujiIndex> KEYSTORE_ACCOUNT=... PASSWORD_FILE=... node indexer/zk-keeper.mjs
//
// Each round: finalize any pending batch whose challenge window has passed (T12), read the contract's
// continuity() (the newest pending batch's end, or the finalized state), fetch the next headers from the
// Bitcoin source, and once a batch is worth proving (ZK_MIN_BATCH headers, or ZK_MAX_WAIT_MIN minutes
// since the head last moved) run the SP1 host (`zk/script prove-input`), then submit foldProof, which
// queues the batch for its challenge window. If proving fails and nothing is pending, fall back to
// foldHeaders with the same headers so the index never depends on a prover (ZK_FALLBACK=0 disables).
// Signs with `cast` and an encrypted keystore; never handles a key. On anvil only (chain 31337),
// ZK_UNLOCKED_FROM=<address> signs with anvil's unlocked account instead.
// ACCOUNTS=<pool,...> also maintains T11 pools on this index (mark epochs from headers, process, retire, sweep).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChain } from './networks.mjs';
import { createBitcoinSource } from './bitcoin-source.mjs';
import { step } from './bitcoin.mjs';
import { contractClient, decodeContinuity, sel, uint } from './zk-challenge.mjs';
import { within as withinMs } from './zk-challenge.mjs';
import { watch } from './zk-watcher.mjs';
import { maintainPool } from './accounts.mjs';
export { decodeContinuity };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const RPC = (env.RPC || '').split(',')[0];
const CHAIN_ID = Number(env.CHAIN_ID || 0);
const INDEX = (env.ZK_INDEX || '').toLowerCase();
const MIN_BATCH = Number(env.ZK_MIN_BATCH || 42);          // 36 folded heights + 6 confirmations ≈ 6 hours
// Capped on chain by MAX_PROOF_HEADERS (250) so a disputed batch can be backed in one transaction.
const MAX_BATCH = Number(env.ZK_MAX_BATCH || 250);
const MAX_WAIT_MIN = Number(env.ZK_MAX_WAIT_MIN || 720);   // prove a smaller batch rather than let the tip age
const INTERVAL = Number(env.INTERVAL || 120);
// Bitcoin source calls get a deadline: on 2026-09-29 one P2P request never settled and the keeper sat
// silently for eight hours with the process still alive. Proving has its own (longer) timeout.
const SOURCE_TIMEOUT_MS = Number(env.ZK_SOURCE_TIMEOUT_S || 120) * 1000;
const within = (promise, what) => withinMs(promise, SOURCE_TIMEOUT_MS, what);
const FALLBACK = env.ZK_FALLBACK !== '0';
// Header-path-only index (verifier = 0, the mainnet plan in T13): fold once ZK_MIN_FOLD heights are past the
// confirmation depth, at most ZK_MAX_FOLD per call, keeping a freeze proof inside one transaction later.
const MIN_FOLD = Number(env.ZK_MIN_FOLD || 36);
const MAX_FOLD = Number(env.ZK_MAX_FOLD || 250);
// Every transaction must stay under the 2^24 per-transaction gas cap (EIP-7825); ≈ 18.7k gas per header.
const headerGas = n => Math.min(16_000_000, 200_000 + 22_000 * n);
// Relayer-bounty tokens (sorted, unique, ≤ 8) credited to this keeper for every height it folds.
const REWARD_TOKENS = (env.ZK_REWARD_TOKENS || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean).sort();
if (REWARD_TOKENS.some(t => !/^0x[0-9a-f]{40}$/.test(t)) || new Set(REWARD_TOKENS).size !== REWARD_TOKENS.length || REWARD_TOKENS.length > 8) {
  throw Error('ZK_REWARD_TOKENS must be up to 8 distinct token addresses');
}
const tokens = `[${REWARD_TOKENS.join(',')}]`;
const HOST = env.ZK_HOST || path.join(root, 'zk/script/target/release/wuji-zk-script');
const WORK = env.ZK_WORK_DIR || path.join(root, 'indexer/data/zk');
if (!RPC || !CHAIN_ID || !/^0x[0-9a-f]{40}$/.test(INDEX)) throw Error('need RPC, CHAIN_ID and ZK_INDEX');
const chain = contractClient({ rpc: RPC, chainId: CHAIN_ID, to: INDEX, env });
if (!chain.canSign) throw Error('need KEYSTORE_ACCOUNT and PASSWORD_FILE');
fs.mkdirSync(WORK, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const { rpc, call } = chain;
const send = (sig, gas, ...args) => chain.send(sig, gas, args);

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
    maxProofHeaders: Number(BigInt(await call(sel('MAX_PROOF_HEADERS()')))),
    headerOnly: BigInt(await call(sel('verifier()'))) === 0n,
  };
  // Batches past their challenge window become what consumers read; anyone may do this, so the keeper does.
  const pending = Number(BigInt(await call(sel('pendingCount()'))));
  if (pending > 0 && BigInt(await call(sel('finalize(uint256)') + uint(8))) > 0n) {
    const tx = await send('finalize(uint256)', 1_500_000, '8');
    log(`finalize gas ${tx.gas} ${tx.hash}`);
  }
  // Never prove on top of a pending batch that does not match the chain: that proof would be removed with
  // it. (A forgery claiming a real hash with a wrong U still links, so the header check below cannot tell.)
  if (pending > 0) {
    const planned = await watch({ chain, sources: [source, source], dryRun: true });
    if (planned.some(a => /^(dispute|refute|reject)/.test(a.sig))) {
      log('pending batches do not match the chain; not extending them (the watcher disputes and refutes)');
      return { action: 'blocked' };
    }
  }
  const start = decodeContinuity(await call(sel('continuity()')));
  if (start.height !== lastHeight) { lastHeight = start.height; lastProgress = Date.now(); }
  const tip = await within(source.tip(), 'Bitcoin tip');
  const available = tip - start.height;
  const waited = (Date.now() - lastProgress) / 60_000;
  const fetchHeaders = async count => {
    const out = [];
    let prev = start.hash.slice(2);
    for (let h = start.height + 1; h <= start.height + count; h++) {
      const b = await within(source.at(h), `Bitcoin header ${h}`);
      const s = step(b.header);
      if (b.header.slice(8, 72) !== prev) throw Error(`header ${h} does not link to ${h - 1}; source may be on another branch`);
      if (s.hash !== b.hash) throw Error(`source hash mismatch at ${h}`);
      out.push(b.header); prev = s.internalHash;
    }
    return out;
  };
  if (immut.headerOnly) {
    if (available <= immut.confirmations || (available < immut.confirmations + MIN_FOLD && waited < MAX_WAIT_MIN)) {
      return { action: 'wait', height: start.height, available };
    }
    const n = Math.min(available, immut.confirmations + MAX_FOLD, immut.maxHeaders);
    const headers = await fetchHeaders(n);
    const tx = await send('foldHeaders(bytes,address[])', headerGas(n), '0x' + headers.join(''), tokens);
    log(`foldHeaders ${n} headers (folds ${n - immut.confirmations}) gas ${tx.gas} ${tx.hash}`);
    return { action: 'headers', ...tx, headers: n };
  }
  if (available <= immut.confirmations || (available < MIN_BATCH && waited < MAX_WAIT_MIN)) {
    return { action: 'wait', height: start.height, available };
  }
  const count = Math.min(available, MAX_BATCH, immut.maxProofHeaders);
  const headers = await fetchHeaders(count);
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
    const tx = await send('foldProof(bytes,bytes,address[])', 1_500_000, p.proof, p.journal, tokens);
    log(`foldProof ${tag} gas ${tx.gas} ${tx.hash}`);
    return { action: 'proof', ...tx, headers: count, newHeight: p.newHeight };
  } catch (e) {
    log('proof path failed:', e.message);
    if (!FALLBACK) throw e;
    // The header path runs only from the finalized state; while batches are pending it would revert.
    if (pending > 0) throw Error('proof path failed with batches pending; header fallback waits for them');
    const n = Math.min(count, immut.maxHeaders);
    const tx = await send('foldHeaders(bytes,address[])', headerGas(n), '0x' + headers.slice(0, n).join(''), tokens);
    log(`fallback foldHeaders ${n} headers gas ${tx.gas} ${tx.hash}`);
    return { action: 'headers', ...tx, headers: n };
  }
}

const ACCOUNTS = (env.ACCOUNTS || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
if (ACCOUNTS.some(a => !/^0x[0-9a-f]{40}$/.test(a))) throw Error('ACCOUNTS must be pool addresses');
const accountCursor = new Map();

/// T11 pools on this index: same duties as the relay keeper, with epochs marked from this keeper's headers.
export async function maintainAccounts(source, pools = ACCOUNTS) {
  const headersFor = async (from, to) => {
    let hex = '0x';
    for (let h = from; h <= to; h++) hex += (await within(source.at(h), `Bitcoin header ${h}`)).header;
    return hex;
  };
  for (const pool of pools) {
    try {
      const r = await maintainPool({
        pool, cursor: accountCursor.get(pool) || 1, log, headersFor,
        read: (to, data) => rpc('eth_call', [{ to, data }, 'latest']),
        simulate: (to, sig, ...args) => chain.simulate(to, sig, ...args),
        send: async (to, sig, gas, ...args) => { const tx = await chain.sendTo(to, sig, gas, args); log('accounts', sig.split('(')[0], pool.slice(0, 10), tx.hash); },
      });
      accountCursor.set(pool, r.cursor);
    } catch (e) { log('accounts:', pool.slice(0, 10), e.message); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = env.ZK_FIXTURE_SOURCE ? fixtureSource(env.ZK_FIXTURE_SOURCE) : createBitcoinSource();
  log(`zk keeper on ${INDEX} (chain ${CHAIN_ID}); batch ${MIN_BATCH}..${MAX_BATCH}, max wait ${MAX_WAIT_MIN} min, fallback ${FALLBACK}`);
  for (;;) {
    try { const r = await round(source); if (r.action === 'wait') log(`waiting: ${r.available} headers past ${r.height}`); }
    catch (e) { log('error:', e.message); }
    if (ACCOUNTS.length) await maintainAccounts(source);
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
