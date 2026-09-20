// Bounded transport retries for idempotent public reads. Never retry a JSON-RPC execution error.
const READS=new Set(['eth_chainId','eth_blockNumber','eth_call','eth_getCode','eth_getBalance','eth_getLogs','eth_getBlockByNumber','eth_getBlockByHash','eth_getTransactionReceipt','eth_getTransactionCount','eth_gasPrice']);
export async function rpcRequest(url,method,params,{fetcher=fetch,attempts=3,timeoutMs=15000,retryDelayMs=250}={}){
 const limit=READS.has(method)?attempts:1;
 const body=JSON.stringify({jsonrpc:'2.0',id:1,method,params});
 for(let attempt=0;attempt<limit;attempt++){
  let result;
  try{
   const response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok){const e=Error(`RPC ${method}: HTTP ${response.status}`);e.retryable=response.status===429||response.status>=500;throw e;}
   result=await response.json();
  }catch(e){
   if(e.retryable===false||attempt+1===limit)throw Error(`RPC ${method} failed after ${attempt+1} attempt(s): ${e.message}`);
   await new Promise(r=>setTimeout(r,retryDelayMs*(attempt+1)));continue;
  }
  if(result.error)throw Error(`RPC ${method}: ${result.error.message}`);
  if(!Object.hasOwn(result,'result'))throw Error(`RPC ${method}: missing result`);
  return result.result;
 }
 throw Error('RPC attempts must be positive');
}
