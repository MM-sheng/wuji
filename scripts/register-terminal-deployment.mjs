// Publish an explicit reviewed release into the standalone HTML, never from an indexer response.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import vm from 'node:vm';
import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {rpcRequest} from '../indexer/evm-rpc.mjs';
export function terminalRelease(j){
 assert.equal(j.status,'confirmed');assert.equal(j.version,'bitcoin-sepolia-v4');assert.equal(j.chainId,11155111);assert.equal(j.frozenExitDelay,144);
 const address=a=>{assert.match(a,/^0x[0-9a-fA-F]{40}$/);assert.notEqual(BigInt(a),0n);return a;};
 const rpc=new URL(j.rpc);assert.equal(rpc.protocol,'https:');assert.equal(rpc.username+rpc.password+rpc.search+rpc.hash,'');
 const vaults=Object.entries(j.vaults).map(([symbol,v])=>{
  assert.match(symbol,/^[A-Z0-9]{1,12}$/);assert.match(v.notional,/^[1-9][0-9]*$/);
  return {symbol,address:address(v.address),asset:address(v.asset),notional:v.notional};
 });assert.ok(vaults.length>0);
 return {chainId:j.chainId,index:address(j.WujiIndex),relay:address(j.BitcoinRelay),rpc:j.rpc,frozenExit:true,frozenExitDelay:144,vaults};
}
export function registerRelease(html,j){
 const d=terminalRelease(j),match=html.match(/  const RELEASES=(.+);/);assert.ok(match,'release registry missing');
 const releases=JSON.parse(match[1]);assert.ok(!releases.sepoliaV4,'v4 release already registered; inspect before replacing immutable addresses');
 releases.sepoliaV4=d;
 return html.replace(match[0],'  const RELEASES='+JSON.stringify(releases)+';').replace('<select id="deploymentSelect">','<select id="deploymentSelect"><option value="sepoliaV4">Ethereum Sepolia · WETH · v4 退出候选</option>');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
 const root=path.resolve(new URL('..',import.meta.url).pathname),manifestFile=path.resolve(process.argv[2]||'contracts/deployments/sepolia-weth-v4.json');
 const j=JSON.parse(fs.readFileSync(manifestFile)),d=terminalRelease(j),file=path.join(root,'apps/terminal/index.html'),html=fs.readFileSync(file,'utf8');
 const updated=registerRelease(html,j); // Validate publication without changing the page yet.
 const verification=JSON.parse(execFileSync('bash',[path.join(root,'scripts/verify-bytecode.sh'),manifestFile],{encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','inherit']}));
 assert.equal(verification.status,'PASS');
 const helpers=html.slice(html.indexOf('  const ADDRESS='),html.indexOf('  // END VERIFICATION HELPERS'));
 const context=vm.createContext({Date,URL});vm.runInContext(helpers+'\nthis.verify=verifySnapshot;',context);
 for(const v of d.vaults)await context.verify((m,p)=>rpcRequest(d.rpc,m,p),d,v,{},0);
 fs.writeFileSync(file,updated);console.log('Registered verified Sepolia v4 release in',file);
}
