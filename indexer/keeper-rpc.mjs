// Keep ABI work offline in Foundry; perform public reads directly without node capability probes.
// `codec` may run only local commands, never a signing command or a network call.
export function keeperReads(rpc, codec) {
  return async (to, signature, ...args) => {
    let from;
    const i = args.indexOf('--from');
    if (i !== -1) {
      if (i !== args.length - 2 || !/^0x[0-9a-f]{40}$/i.test(args[i + 1])) throw Error('Invalid simulated sender');
      from = args[i + 1]; args = args.slice(0, i);
    }
    const data = codec('calldata', signature, ...args);
    const raw = await rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
    if (!/^0x(?:[0-9a-f]{64})+$/i.test(raw)) throw Error('Invalid keeper call result');
    return codec('abi-decode', signature, raw);
  };
}

export function quantity(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw Error('Invalid RPC quantity');
  return BigInt(value);
}

// This is an affordability floor at the sampled gas price, not a promise that a future fee cap fits.
// Leave automatic fee selection to the existing signer. Never retry a send from here.
export async function workerReady(rpc, worker, gasLimit, explicitGasPrice) {
  const [latest, pending, balance, price] = await Promise.all([
    rpc('eth_getTransactionCount', [worker, 'latest']), rpc('eth_getTransactionCount', [worker, 'pending']),
    rpc('eth_getBalance', [worker, 'latest']),
    explicitGasPrice === undefined ? rpc('eth_gasPrice', []) : '0x' + explicitGasPrice.toString(16),
  ]);
  if (quantity(latest) !== quantity(pending)) throw Error('Worker has a pending transaction; wait for its receipt before signing');
  const available = quantity(balance), minimum = gasLimit * quantity(price);
  if (available < minimum) throw Error(`Insufficient native balance before signing: have ${available} wei, need at least ${minimum} wei`);
}
