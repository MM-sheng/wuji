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
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChain } from './networks.mjs';
import { createBitcoinSource } from './bitcoin-source.mjs';
import { step } from './bitcoin.mjs';
import { contractClient, decodeContinuity, sel, uint } from './zk-challenge.mjs';
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
const within = (promise, what) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(Error(`${what} timed out after ${SOURCE_TIMEOUT_MS / 1000} s`)), SOURCE_TIMEOUT_MS).unref())]);
const FALLBACK = env.ZK_FALLBACK !== '0';
const HOST = env.ZK_HOST || path.join(root, 'zk/script/target/release/wuji-zk-script');
const WORK = env.ZK_WORK_DIR || path.join(root, 'indexer/data/zk');
if (!RPC || !CHAIN_ID || !/^0x[0-9a-f]{40}$/.test(INDEX)) throw Error('need RPC, CHAIN_ID and ZK_INDEX');
const chain = contractClient({ rpc: RPC, chainId: CHAIN_ID, to: INDEX, env });
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
  };
  // Batches past their challenge window become what consumers read; anyone may do this, so the keeper does.
  const pending = Number(BigInt(await call(sel('pendingCount()'))));
  if (pending > 0 && BigInt(await call(sel('finalize(uint256)') + uint(8))) > 0n) {
    const tx = await send('finalize(uint256)', 1_500_000, '8');
    log(`finalize gas ${tx.gas} ${tx.hash}`);
  }
  const start = decodeContinuity(await call(sel('continuity()')));
  if (start.height !== lastHeight) { lastHeight = start.height; lastProgress = Date.now(); }
  const tip = await within(source.tip(), 'Bitcoin tip');
  const available = tip - start.height;
  const waited = (Date.now() - lastProgress) / 60_000;
  if (available <= immut.confirmations || (available < MIN_BATCH && waited < MAX_WAIT_MIN)) {
    return { action: 'wait', height: start.height, available };
  }
  const count = Math.min(available, MAX_BATCH, immut.maxProofHeaders);
  const headers = [];
  let prev = start.hash.slice(2);
  for (let h = start.height + 1; h <= start.height + count; h++) {
    const b = await within(source.at(h), `Bitcoin header ${h}`);
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
    // The header path runs only from the finalized state; while batches are pending it would revert.
    if (pending > 0) throw Error('proof path failed with batches pending; header fallback waits for them');
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
