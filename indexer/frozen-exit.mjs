// The same dependency-free reader is embedded in the standalone terminal.
// `read` MUST pin every call to one EVM block; callers check that block's hash afterward.
export async function readFrozenExit(read, index, relay) {
  const uint = value => {
    if (!/^0x[0-9a-f]{64}$/i.test(value)) throw Error('Invalid frozen-exit ABI');
    return BigInt(value);
  };
  const bool = value => { const n = uint(value); if (n > 1n) throw Error('Invalid boolean'); return n === 1n; };
  const [f, consistent, ready, delay, notice, revision, height, folded, hash] = await Promise.all([
    read(index, '0x054f7d9c'), read(index, '0x68c5cf08'), read(index, '0x482c25fd'),
    read(index, '0x8dbbb868'), read(index, '0xfcbbb8a9'), read(relay, '0x12c5c524'),
    read(relay, '0x8cef3d2a'), read(index, '0x25159aa9'), read(index, '0x3fa21806')
  ]);
  if (!/^0x[0-9a-f]{384}$/i.test(notice)) throw Error('Invalid reorg notice');
  const w = n => '0x' + notice.slice(2 + n * 64, 66 + n * 64);
  const from = uint(w(0)), deadline = uint(w(1)), best = uint(height);
  const canonical = from ? await read(relay, '0xec1867e3' + from.toString(16).padStart(64, '0')) : null;
  const frozen = bool(f), historyConsistent = bool(consistent), exitReady = bool(ready);
  const valid = from > 0n && !historyConsistent && uint(w(2)) === uint(folded) &&
    uint(w(3)) === uint(hash) && uint(w(5)) === uint(revision) && uint(canonical) === uint(w(4));
  if (exitReady !== (!frozen && valid && best >= deadline)) throw Error('Inconsistent exit readiness');
  return { frozen, historyConsistent, exitReady, noticeValid: valid,
    delay: Number(uint(delay)), relayHeight: Number(best), revision: uint(revision).toString(),
    fromHeight: Number(from), readyHeight: Number(deadline), remaining: valid ? Number(best < deadline ? deadline - best : 0n) : null,
    phase: frozen ? 'frozen' : historyConsistent ? 'active' : !valid ? 'unobserved' : exitReady ? 'ready' : 'waiting' };
}

export function exitActionAllowed(state, action) {
  if (!state?.frozenExit) return false;
  const x = state.frozenExit;
  if (action === 'observe') return !x.frozen && !x.historyConsistent && !x.noticeValid;
  if (action === 'freeze') return x.exitReady && !x.frozen;
  if (action === 'close') return x.frozen && !state.closed;
  if (action === 'pair') return true;
  if (action === 'settled') return state.settled === true;
  return false;
}
