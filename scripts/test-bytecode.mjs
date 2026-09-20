// CI integration: isolated Anvil, unlocked throwaway accounts, real production constructors.
// Rebuild in a different checkout path; never use a private key or a funded public-network wallet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import net from 'node:net';
import {rpcRequest} from '../indexer/evm-rpc.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-repro-ci-'));
const executable=name=>process.env[name.toUpperCase()]||(fs.existsSync(path.join(os.homedir(),'.foundry/bin',name))?path.join(os.homedir(),'.foundry/bin',name):name);
const freePort=net.createServer();await new Promise(r=>freePort.listen(0,'127.0.0.1',r));const port=freePort.address().port;await new Promise(r=>freePort.close(r));
const rpcUrl=`http://127.0.0.1:${port}`;
const anvil=spawn(executable('anvil'),['--host','127.0.0.1','--port',String(port),'--silent'],{stdio:'ignore'});
let spawnError;anvil.on('error',e=>{spawnError=e;});
try{
 for(const dir of ['contracts/src','contracts/script','contracts/test','contracts/lib'])fs.cpSync(path.join(root,dir),path.join(temp,dir),{recursive:true,filter:p=>path.basename(p)!=='.git'});
 for(const name of ['contracts/foundry.toml','contracts/remappings.txt','contracts/remappings-v3.json','scripts/build-reproducible.mjs','indexer/evm-rpc.mjs','scripts/verify-bytecode.sh','scripts/verify-bytecode.mjs']){
  const target=path.join(temp,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,name),target);
 }
 const rpc=(method,params)=>rpcRequest(rpcUrl,method,params,{attempts:1,timeoutMs:2000});
 let accounts;
 for(let i=0;i<100;i++){
  if(spawnError)throw spawnError;if(anvil.exitCode!==null)throw Error('Anvil exited during startup');
  try{accounts=await rpc('eth_accounts',[]);break;}catch{await new Promise(r=>setTimeout(r,100));}
 }
 assert.ok(accounts?.length,'Anvil did not start');
 const meta=JSON.parse(fs.readFileSync(path.join(temp,'contracts/test/fixtures/bitcoin.json')));
 const out=path.join(temp,'contracts/out');
 execFileSync(executable('forge'),['build','--root',path.join(temp,'contracts'),'--build-info','--force'],{stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
 execFileSync(process.execPath,[path.join(temp,'scripts/build-reproducible.mjs'),temp,out],{stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
 const cast=(...args)=>execFileSync(executable('cast'),args,{encoding:'utf8'}).trim();
 const predicted=cast('compute-address',accounts[0],'--nonce','2').match(/0x[0-9a-fA-F]{40}/)[0];
 const transaction=async(to,data)=>{
  const hash=await rpc('eth_sendTransaction',[{from:accounts[0],...(to?{to}:{}),data,gas:'0x989680'}]);
  let receipt;for(let i=0;i<100;i++){receipt=await rpc('eth_getTransactionReceipt',[hash]);if(receipt)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(receipt?.status,'0x1','local constructor/call missing or reverted');return receipt;
 };
 const manifest={status:'confirmed',chainId:31337,rpc:rpcUrl,vaults:{}};
 const deploy=async(name,signature,...args)=>{
  const file=(name==='SeriesTokenDeployer'?'SeriesToken':name)+'.sol';
  const artifact=JSON.parse(fs.readFileSync(path.join(out,file,name+'.json')));
  const encoded=signature?cast('abi-encode',signature,...args).slice(2):'';
  const receipt=await transaction(null,'0x'+artifact.bytecode.object.replace(/^0x/,'')+encoded);
  manifest[name]=receipt.contractAddress;return receipt.contractAddress;
 };
 const rewards=await deploy('RelayerRewards','f(address,uint64)',predicted,String(meta.start));
 const relay=await deploy('BitcoinRelay','f(bytes,uint64,uint32,uint256,bytes)','0x'+meta.checkpointHeader,String(meta.checkpointHeight),String(meta.epochStartTime),'1000000000000000000000000000000',fs.readFileSync(path.join(temp,'contracts/test/fixtures/bitcoin-timestamps-ancestors.hex'),'utf8').trim());
 const index=await deploy('WujiIndex','f(address,uint64,uint64,address)',relay,String(meta.start),'4320',rewards);
 assert.equal(index.toLowerCase(),predicted.toLowerCase());
 const router=await deploy('FeeRouter','f(address)',rewards),tokens=await deploy('SeriesTokenDeployer');
 const factory=await deploy('WujiVaultFactory','f(address,address,address)',index,router,tokens);
 for(const name of ['MockUSDT','MockWBNB']){
  const asset=await deploy(name);await transaction(factory,cast('calldata','create(address,uint256)',asset,'1000000000000000000'));
 }
 // Factory-created vault addresses are read from its registry; these also contain immutable slots.
 for(const [symbol,i] of [['USDT',0],['WBNB',1]]){
  const value=await rpc('eth_call',[{to:manifest.WujiVaultFactory,data:'0x8c64ea4a'+BigInt(i).toString(16).padStart(64,'0')},'latest']);manifest.vaults[symbol]={address:'0x'+value.slice(-40)};
 }
 const manifestFile=path.join(temp,'local-deployment.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 const output=execFileSync('bash',[path.join(temp,'scripts/verify-bytecode.sh'),manifestFile],{env:{...process.env,FORGE:executable('forge'),READ_RPC:rpcUrl,BYTECODE_OUTPUT:''},encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
 const result=JSON.parse(output);assert.equal(result.status,'PASS');assert.equal(result.verified.length,8);
 // Cross-directory metadata equality against the primary checkout's fresh build as well.
 const second=execFileSync('bash',[path.join(root,'scripts/verify-bytecode.sh'),manifestFile],{env:{...process.env,FORGE:executable('forge'),READ_RPC:rpcUrl,BYTECODE_OUTPUT:''},encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
 assert.equal(JSON.parse(second).status,'PASS');
 // A real deployed runtime change must be rejected by the CLI, including its exit code.
 const address=manifest.FeeRouter,code=await rpc('eth_getCode',[address,'latest']);
 await rpc('anvil_setCode',[address,code.slice(0,-2)+(code.endsWith('ff')?'00':'ff')]);
 let rejected=false;
 try{execFileSync('bash',[path.join(temp,'scripts/verify-bytecode.sh'),manifestFile],{env:{...process.env,FORGE:executable('forge'),READ_RPC:rpcUrl,BYTECODE_OUTPUT:''},stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});}
 catch(e){const failure=JSON.parse(e.stdout.toString());assert.equal(e.status,1);assert.equal(failure.status,'FAIL');assert.match(failure.reason,/FeeRouter.*mismatch/);rejected=true;}
 assert.ok(rejected,'tampered deployment must fail');
 console.log('PASS: 8 real local runtimes; fresh builds in two checkout paths; tampered on-chain metadata rejected.');
}finally{
 if(anvil.exitCode===null&&!spawnError){anvil.kill('SIGTERM');await new Promise(r=>anvil.once('exit',r));}
 fs.rmSync(temp,{recursive:true,force:true});
}
