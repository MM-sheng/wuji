// WUJI ZK watcher (T12) — checks every pending ZkWujiIndex batch against the real Bitcoin chain.
//
//   RPC=... CHAIN_ID=... ZK_INDEX=<ZkWujiIndex> KEYSTORE_ACCOUNT=... PASSWORD_FILE=... node indexer/zk-watcher.mjs
//
// Each round, oldest batch first: replay the real headers from the batch's starting state and compare the
// result with what the batch claims (hash, height, bits, time, epoch start, U, work, median-time-past
// window, checkpoints). The header at the claimed height must agree between two independent Bitcoin
// sources (WATCH_SOURCES, default "p2p,http") before the watcher acts on it.
//   * mismatch, window open                    → dispute if needed (posts DISPUTE_BOND), then refute with
//                                                the real headers at once (bond back; oldest batch: the
//                                                real state is folded in its place); reject as a fallback
//   * disputed, matches, response window open  → back with the raw headers (earns the bond)
//   * past its window and undisputed, or backed → finalize
// Anyone can run this; the protocol is only as safe as the most attentive watcher. WATCH_DRY_RUN=1 logs
// what it would send and sends nothing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBitcoinSource } from './bitcoin-source.mjs';
import { step } from './bitcoin.mjs';
import { contractClient, decodeBatch, decodeContinuity, differences, replay, sel, uint } from './zk-challenge.mjs';

const env = process.env;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const SOURCE_TIMEOUT_MS = Number(env.ZK_SOURCE_TIMEOUT_S || 120) * 1000;
const within = (promise, what) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(Error(`${what} timed out after ${SOURCE_TIMEOUT_MS / 1000} s`)), SOURCE_TIMEOUT_MS).unref())]);

/// One watcher round. `chain` is a contractClient; `sources` are two independent Bitcoin sources
/// ({tip(), at(h) → {header, hash}}); `dryRun` returns the planned actions without sending them.
export async function watch({ chain, sources: [primary, second], dryRun = false }) {
  const num = async sig => Number(BigInt(await chain.call(sel(sig))));
  const first = await num('firstPending()'), next = await num('nextBatch()');
  if (first === next) return [];
  const config = {
    genesisHeight: await num('GENESIS_HEIGHT()'), checkpointInterval: await num('CHECKPOINT_INTERVAL()'),
    confirmations: await num('CONFIRMATIONS()'),
  };
  const bond = BigInt(await chain.call(sel('DISPUTE_BOND()')));
  const now = Number(BigInt((await chain.rpc('eth_getBlockByNumber', ['latest', false])).timestamp));
  const actions = [];
  const act = async (what, sig, gas, args, value) => {
    actions.push({ what, sig, args });
    if (dryRun) { log('[dry run]', what); return; }
    const tx = await chain.send(sig, gas, args, value);
    log(`${what} gas ${tx.gas} ${tx.hash}`);
  };

  let ready = false;
  for (let id = first; id < next; id++) {
    const b = decodeBatch(await chain.call(sel('batch(uint256)') + uint(id)));
    const start = decodeContinuity(await chain.call(sel('stateBefore(uint256)') + uint(id)));
    const disputed = b.disputer !== '0x' + '0'.repeat(40);

    const count = b.to.height - start.height + config.confirmations;
    const tip = await within(primary.tip(), 'Bitcoin tip');
    if (tip < start.height + count) {
      log(`batch ${id}: source tip ${tip} is short of ${start.height + count}; cannot check yet`);
      break;
    }
    const headers = [];
    for (let h = start.height + 1; h <= start.height + count; h++) {
      headers.push((await within(primary.at(h), `Bitcoin header ${h}`)).header);
    }
    let truth;
    try { truth = replay(start, headers, config); } catch (e) { truth = null; log(`batch ${id}: cannot replay from its start (${e.message})`); }
    // The start of a later batch is the previous batch's claim; if that does not link to real headers,
    // the problem is the earlier batch, which this loop has already handled.
    if (!truth) break;
    const realAtTarget = step(headers[b.to.height - start.height - 1]).hash;
    const other = await within(second.at(b.to.height), `second source header ${b.to.height}`);
    if (other.hash !== realAtTarget) {
      log(`batch ${id}: sources disagree at ${b.to.height} (${realAtTarget} vs ${other.hash}); not acting`);
      break;
    }
    const diff = differences(b, truth);

    if (diff.length) {
      log(`batch ${id} (${start.height + 1}..${b.to.height}) does not match the chain: ${diff.join(', ')}`);
      if (!disputed && now >= b.finalAt) {
        log(`batch ${id}: MISMATCH PAST ITS WINDOW — it will finalize; this is the loss case`);
        break;
      }
      if (!disputed) await act(`dispute batch ${id}`, 'dispute(uint256,address[])', 300_000, [String(id), '[]'], bond);
      // Refute at once with the real headers (no need to wait out the response window); for the oldest
      // batch this also folds the real state, so forged proofs at the head of the queue cannot hold the index.
      try {
        await act(`refute batch ${id} with ${count} headers`, 'refute(uint256,bytes,address[])', 600_000 + 120_000 * count,
          [String(id), '0x' + headers.join(''), '[]']);
      } catch (e) {
        log(`refute batch ${id} failed: ${e.message}`);
        if (disputed && !b.backed && now > b.respondBy) await act(`reject batch ${id}`, 'reject(uint256)', 3_000_000, [String(id)]);
      }
      break; // everything after it is built on it
    }
    log(`batch ${id} (${start.height + 1}..${b.to.height}) matches the chain${disputed ? ' (disputed)' : `; final at ${new Date(b.finalAt * 1000).toISOString().slice(0, 16)}Z`}`);
    if (disputed && !b.backed && now <= b.respondBy) {
      const gas = 600_000 + 120_000 * count;
      await act(`back batch ${id} with ${count} headers`, 'back(uint256,bytes)', gas, [String(id), '0x' + headers.join('')]);
    }
    if (id === first && (b.backed || (!disputed && now >= b.finalAt))) ready = true;
  }
  if (ready) await act('finalize', 'finalize(uint256)', 1_500_000, ['8']);
  return actions;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const RPC = (env.RPC || '').split(',')[0], CHAIN_ID = Number(env.CHAIN_ID || 0), INDEX = (env.ZK_INDEX || '').toLowerCase();
  if (!RPC || !CHAIN_ID || !/^0x[0-9a-f]{40}$/.test(INDEX)) throw Error('need RPC, CHAIN_ID and ZK_INDEX');
  const kinds = (env.WATCH_SOURCES || 'p2p,http').split(',').map(s => s.trim());
  if (kinds.length !== 2 || kinds[0] === kinds[1]) throw Error('WATCH_SOURCES needs two different sources, e.g. p2p,http');
  const sources = kinds.map(source => createBitcoinSource({ source }));
  const chain = contractClient({ rpc: RPC, chainId: CHAIN_ID, to: INDEX, env });
  const interval = Number(env.INTERVAL || 300);
  log(`zk watcher on ${INDEX} (chain ${CHAIN_ID}); sources ${kinds.join(' + ')}; every ${interval} s${env.WATCH_DRY_RUN ? ' (dry run)' : ''}`);
  for (;;) {
    try { await watch({ chain, sources, dryRun: !!env.WATCH_DRY_RUN }); } catch (e) { log('error:', e.message); }
    if (env.ZK_ONCE) break;
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}
