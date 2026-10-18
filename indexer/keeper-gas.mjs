// Some chains price new state separately from local EVM execution. Opt-in live estimates must stay
// below an explicit operator ceiling; a failed estimate must never silently fall back to an undersized tx.
export async function estimateKeeperGas({rpc,from,to,data,value,fallbackGas,maxGas}) {
  for(const n of [fallbackGas,maxGas]) if(!Number.isSafeInteger(n)||n<=0) throw Error('invalid keeper gas bound');
  const block=await rpc('eth_getBlockByNumber',['latest',false]);
  const cap=BigInt(maxGas)<BigInt(block.gasLimit)?BigInt(maxGas):BigInt(block.gasLimit);
  const request={from,to,data,gas:'0x'+cap.toString(16),...(value===undefined?{}:{value:'0x'+BigInt(value).toString(16)})};
  const estimate=BigInt(await rpc('eth_estimateGas',[request,'latest']));
  if(estimate<=0n) throw Error('invalid keeper gas estimate');
  const padded=(estimate*125n+99n)/100n;
  const gas=padded>BigInt(fallbackGas)?padded:BigInt(fallbackGas);
  if(gas>cap) throw Error('keeper gas estimate exceeds configured or block gas ceiling');
  return Number(gas);
}
