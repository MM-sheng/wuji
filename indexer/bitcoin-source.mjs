// Pick the Bitcoin header source. Default: public Esplora HTTP APIs. BITCOIN_SOURCE=p2p uses the
// network directly (no third party, no quota) — see bitcoin-p2p.mjs.
import { BitcoinAPI } from './bitcoin.mjs';
import { BitcoinP2P } from './bitcoin-p2p.mjs';

const stamp = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function createBitcoinSource(options = {}) {
  const kind = (options.source ?? process.env.BITCOIN_SOURCE ?? 'http').toLowerCase();
  // Log peer activity by default: a source that fails silently is the failure mode that cost an hour
  // of stalled keeper time on 2026-09-23.
  if (kind === 'p2p') return new BitcoinP2P({ log: stamp, ...options });
  if (kind === 'http') return new BitcoinAPI(undefined, options);
  throw Error(`Unknown BITCOIN_SOURCE '${kind}' (expected http or p2p)`);
}
