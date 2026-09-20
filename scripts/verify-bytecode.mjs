// Runtime equality including compiler metadata; mask only compiler-declared immutable slots.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
function bytes(hex){assert.match(hex,/^(0x)?(?:[0-9a-fA-F]{2})+$/,'missing or invalid runtime bytecode');return Buffer.from(hex.replace(/^0x/,''),'hex');}
export function compareRuntime(artifact,code){
 const expected=bytes(artifact.deployedBytecode.object),actual=bytes(code);
 assert.equal(actual.length,expected.length,'runtime length mismatch');
 const actualSha256=digest(actual),ranges=Object.values(artifact.deployedBytecode.immutableReferences||{}).flat().sort((a,b)=>a.start-b.start);
 let end=0;
 for(const {start,length} of ranges){
  assert.ok(Number.isSafeInteger(start)&&start>=end&&length===32&&start+length<=expected.length,'invalid immutable range');
  assert.ok(expected.subarray(start,start+length).every(b=>b===0),'compiled immutable slot is not zero');
  actual.fill(0,start,start+length);expected.fill(0,start,start+length);end=start+length;
 }
 assert.ok(actual.equals(expected),'runtime mismatch outside immutable slots (metadata is included)');
 return {status:'PASS',bytes:actual.length,immutableSlots:ranges.length,actualSha256,maskedSha256:digest(actual)};
}
export async function verifyBytecode(manifest,artifactDir,{fetcher=fetch,rpcUrl=manifest.rpc}={}){
 assert.equal(manifest.status,'confirmed','unconfirmed deployment');
 const rpc=(method,params)=>rpcRequest(rpcUrl,method,params,{fetcher});
 assert.equal(BigInt(await rpc('eth_chainId',[])),BigInt(manifest.chainId),'wrong settlement chain');
 const block=await rpc('eth_getBlockByNumber',['latest',false]);assert.ok(block?.hash&&block.number,'missing observation block');
 const contracts=[...['BitcoinRelay','WujiIndex','SeriesTokenDeployer','WujiVaultFactory','RelayerRewards','FeeRouter'].map(n=>[n,manifest[n]]),...Object.values(manifest.vaults||{}).map(v=>['WujiVault',v.address])];
 assert.ok(contracts.length>6,'manifest needs at least one vault');
 const verified=[];
 for(const [name,address] of contracts){
  assert.match(address,/^0x[0-9a-fA-F]{40}$/,'missing contract address');
  const artifact=JSON.parse(fs.readFileSync(path.join(artifactDir,(name==='SeriesTokenDeployer'?'SeriesToken':name)+'.sol',name+'.json')));
  assert.equal(artifact.metadata.compiler.version,'0.8.28+commit.7893614a','wrong compiler');
  try{verified.push({name,address,...compareRuntime(artifact,await rpc('eth_getCode',[address,block.number]))});}
  catch(e){throw Error(`${name} (${address}): ${e.message}`);}
 }
 assert.equal((await rpc('eth_getBlockByNumber',[block.number,false]))?.hash,block.hash,'EVM observation block reorged');
 return {status:'PASS',checkedAt:new Date().toISOString(),chainId:manifest.chainId,evmBlock:Number(BigInt(block.number)),evmBlockHash:block.hash,compiler:'0.8.28+commit.7893614a',verified,scope:'Fresh build runtime equality, including metadata, with only compiler-declared immutable slots masked. Does not verify immutable values, external collateral code, contract state or safety. Use the deployment binding checks separately.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
 let result;
 try{const manifest=JSON.parse(fs.readFileSync(process.argv[2]));result=await verifyBytecode(manifest,process.argv[3],{rpcUrl:process.env.READ_RPC||manifest.rpc});}
 catch(e){result={status:'FAIL',checkedAt:new Date().toISOString(),reason:e.message};process.exitCode=1;}
 const output=JSON.stringify(result,null,2)+'\n';process.stdout.write(output);if(process.env.BYTECODE_OUTPUT)fs.writeFileSync(process.env.BYTECODE_OUTPUT,output);
}
