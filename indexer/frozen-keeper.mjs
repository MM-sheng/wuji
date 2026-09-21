import { readFrozenExit } from './frozen-exit.mjs';

// This automation is enabled explicitly for v4 TESTNET manifests only.
// Eligibility comes from contract state, never from an indexer error or a Bitcoin HTTP error.
export async function maintainFrozenExit({ rpc, index, relay, vaults, send, chainId, now = Date.now() }) {
  if (![97, 11155111].includes(chainId)) throw Error('Frozen-exit automation is testnet-only');
  if (Number(BigInt(await rpc('eth_chainId', []))) !== chainId) throw Error('RPC chain mismatch');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!block?.hash || Math.abs(now / 1000 - Number(BigInt(block.timestamp))) > 120) throw Error('Stale exit snapshot');
  const read = (to, data) => rpc('eth_call', [{ to, data }, block.number]);
  const binding = await read(index, '0xb59589d1');
  if ('0x' + binding.slice(-40).toLowerCase() !== relay.toLowerCase()) throw Error('Exit relay binding mismatch');
  const state = await readFrozenExit(read, index, relay);
  const targets = [];
  if (state.frozen) for (const vault of await vaults()) {
    if ('0x' + (await read(vault, '0x2986c0e5')).slice(-40).toLowerCase() !== index.toLowerCase()) throw Error('Exit vault binding mismatch');
    if (BigInt(await read(vault, '0x597e1fb5')) === 0n) targets.push(vault);
  }
  if ((await rpc('eth_getBlockByNumber', [block.number, false]))?.hash !== block.hash) throw Error('EVM reorg during exit snapshot');
  // No resubmission while waiting. A branch revision invalidates the notice on chain.
  if (state.phase === 'unobserved') await send(index, 'observeReorg()', 250_000);
  if (state.phase === 'ready') await send(index, 'freeze()', 200_000);
  for (const vault of targets) await send(vault, 'settleFrozen()', 350_000);
  return state;
}
