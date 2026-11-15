// Bounded transport retries for idempotent public reads. Never retry a JSON-RPC execution revert.
const READS=new Set(['eth_chainId','eth_blockNumber','eth_call','eth_getCode','eth_getBalance','eth_getLogs','eth_getBlockByNumber','eth_getBlockByHash','eth_getTransactionReceipt','eth_getTransactionCount','eth_gasPrice']);
// Never log URLs, request bodies, credentials or arbitrary nested exception messages.
function transportDetail(error){
 const codes=new Set(),seen=new Set();
 const visit=(e,depth)=>{
  if(!e||typeof e!=='object'||seen.has(e)||depth>4)return;seen.add(e);
  if(typeof e.code==='string'&&/^(?:UND_ERR_[A-Z_]+|E[A-Z0-9_]{2,40})$/.test(e.code))codes.add(e.code);
  if(['TimeoutError','AbortError','SyntaxError'].includes(e.name))codes.add(e.name);
  visit(e.cause,depth+1);
  if(Array.isArray(e.errors))for(const nested of e.errors.slice(0,8))visit(nested,depth+1);
 };visit(error,0);
 return [...codes].join(',')||'unclassified';
}
function isExecutionRevert(err){
 if(!err||typeof err!=='object')return false;
 const msg=String(err.message??'');
 const data=typeof err.data==='string'?err.data:typeof err.data?.data==='string'?err.data.data:'';
 if(err.code===3||/^0x(?:08c379a0|4e487b71)/i.test(data))return true;
 return /execution reverted|\brevert(?:ed)?\b|invalid opcode|out of gas|VM Exception/i.test(msg);
}
function isRetryableRpcError(err){
 if(!err||typeof err!=='object'||isExecutionRevert(err))return false;
 if([-32005,-32603,-32002].includes(Number(err.code)))return true;
 return /rate.?limit|too many requests|timeout|timed out|header not found|block not found|missing trie node|service unavailable|backend|temporar|busy/i.test(String(err.message??''));
}
function safeRpcMessage(msg){
 return String(msg??'unknown RPC error').replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,240);
}
export async function rpcRequest(url,method,params,{fetcher=fetch,attempts=3,timeoutMs=15000,retryDelayMs=250}={}){
 if(!Number.isInteger(attempts)||attempts<1)throw Error('RPC attempts must be a positive integer');
 const limit=READS.has(method)?attempts:1;
 const body=JSON.stringify({jsonrpc:'2.0',id:1,method,params});
 for(let attempt=0;attempt<limit;attempt++){
  let result;
  try{
   const response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok){const e=Error('HTTP failure');e.httpStatus=response.status;e.retryable=response.status===429||response.status>=500;throw e;}
   result=await response.json();
  }catch(e){
   if(e.retryable===false||attempt+1===limit){
    const detail=e.httpStatus?`HTTP ${e.httpStatus}`:`transport ${transportDetail(e)}`;
    const failure=Error(`RPC ${method} failed after ${attempt+1} attempt(s): ${detail}`);
    failure.rpcReadError=true;failure.rpcTransportError=e.retryable!==false;failure.transportDetail=detail;throw failure;
   }
   await new Promise(r=>setTimeout(r,retryDelayMs*(attempt+1)));continue;
  }
  if(result.error){
   if(isExecutionRevert(result.error)){
    const revert=Error(`RPC ${method}: ${safeRpcMessage(result.error.message)}`);
    revert.isExecutionRevert=true;revert.rpcReadError=false;revert.rpcTransportError=false;throw revert;
   }
   const retryable=isRetryableRpcError(result.error);
   if(retryable&&attempt+1<limit){await new Promise(r=>setTimeout(r,retryDelayMs*(attempt+1)));continue;}
   const failure=Error(`RPC ${method}: ${safeRpcMessage(result.error.message)}`);
   failure.rpcReadError=true;failure.rpcTransportError=retryable;failure.rpcCode=result.error.code;throw failure;
  }
  if(!Object.hasOwn(result,'result')){
   if(attempt+1<limit){await new Promise(r=>setTimeout(r,retryDelayMs*(attempt+1)));continue;}
   const missing=Error(`RPC ${method}: missing result`);
   missing.rpcReadError=true;missing.rpcTransportError=true;throw missing;
  }
  return result.result;
 }
 throw Error('RPC attempts must be positive');
}
