// Offline container smoke: real HTTP/proof persistence and a keeper stopped by wrong-chain RPC.
// No usable key, password or public-network transaction is involved.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(root,'indexer/data'),{recursive:true});
const temp=fs.mkdtempSync(path.join(root,'indexer/data/container-test-'));fs.chmodSync(temp,0o755);
const project='wuji-container-'+process.pid;
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const docker=(...args)=>execFileSync('docker',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024});
const manifest=JSON.parse(fs.readFileSync(path.join(root,'contracts/deployments/sepolia-weth-v3.json')));manifest.genesisHeight=798336;
fs.writeFileSync(path.join(temp,'manifest.json'),JSON.stringify(manifest));
fs.writeFileSync(path.join(temp,'headers.hex'),fs.readFileSync(path.join(root,'contracts/test/fixtures/bitcoin-798336.hex'),'utf8').trim().replace(/^0x/,'').slice(0,20*160));
fs.writeFileSync(path.join(temp,'dummy-keystore'),'not-a-wallet');fs.writeFileSync(path.join(temp,'dummy-password'),'not-a-password');
fs.writeFileSync(path.join(temp,'source.mjs'),`import http from 'node:http';import fs from 'node:fs';import {step} from '/app/indexer/bitcoin.mjs';
const rows=fs.readFileSync('/fixture/headers.hex','utf8').match(/.{160}/g).map(header=>({header,...step(header)})),methods=[];
http.createServer(async(req,res)=>{
 if(req.method==='POST'){let body='';for await(const part of req)body+=part;const r=JSON.parse(body);methods.push(r.method);res.setHeader('content-type','application/json');return res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,result:'0x1'}));}
 if(req.url==='/stats')return res.end(JSON.stringify(methods));
 if(req.url==='/blocks/tip/height')return res.end('798346');
 if(req.url.startsWith('/block-height/'))return res.end(rows[Number(req.url.split('/').at(-1))-798336]?.hash||'');
 const hash=req.url.split('/')[2],row=rows.find(r=>r.hash===hash);if(row)return res.end(row.header);res.statusCode=404;res.end();
}).listen(8080,'0.0.0.0');`);
const mount={type:'bind',source:temp,target:'/fixture',read_only:true};
const override={services:{source:{image:'wuji-node:local',entrypoint:['node','/fixture/source.mjs'],volumes:[mount]},indexer:{environment:{MANIFEST:'/fixture/manifest.json',RPC:'http://source:8080',BITCOIN_API:'http://source:8080',BITCOIN_REQUEST_DELAY_MS:'0'},volumes:[mount]},keeper:{environment:{MANIFEST:'/fixture/manifest.json',RPC:'http://source:8080',BITCOIN_API:'http://source:8080',BITCOIN_REQUEST_DELAY_MS:'0',INTERVAL:'1'},volumes:[mount]}}};
const overrideFile=path.join(temp,'compose.json');fs.writeFileSync(overrideFile,JSON.stringify(override));
const env={...process.env,WUJI_PORT:String(port),KEYSTORE_ACCOUNT:'dummy',KEYSTORE_FILE:path.join(temp,'dummy-keystore'),PASSWORD_FILE:path.join(temp,'dummy-password')};
const compose=(...args)=>execFileSync('docker',['compose','-p',project,'-f','docker-compose.yml','-f',overrideFile,...args],{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024});
try{
 compose('up','-d','source','indexer','keeper');
 // 60 s: container start-up plus the indexer's first sync (CI timed out at the former 20 s).
 const until=async test=>{for(let i=0;i<300;i++){try{const r=await test();if(r)return r;}catch{}await new Promise(r=>setTimeout(r,200));}throw Error('container smoke timed out');};
 const head=await until(async()=>{const h=await(await fetch(`http://127.0.0.1:${port}/head`)).json();return h.blocks===5&&h.chain?.err?h:null;});
 assert.equal(head.height,798340);assert.match(head.chain.err,/chain mismatch/);
 const proof=await(await fetch(`http://127.0.0.1:${port}/proof/798340`)).json();assert.match(proof.S_wad,/^-?\d+$/);
 compose('restart','indexer');const restored=await until(async()=>{const h=await(await fetch(`http://127.0.0.1:${port}/head`)).json();return h.blocks===5?h:null;});assert.equal(restored.U,head.U);
 const keeperId=compose('ps','-q','keeper').trim(),config=JSON.parse(docker('inspect',keeperId))[0];
 assert.equal(config.Config.User,'node');assert.equal(config.HostConfig.ReadonlyRootfs,true);
 for(const destination of ['/run/secrets/keeper-password','/home/node/.foundry/keystores/dummy'])assert.equal(config.Mounts.find(m=>m.Destination===destination)?.RW,false);
 const logs=await until(()=>{const log=compose('logs','keeper');return /chain mismatch/.test(log)?log:null;});assert.match(logs,/chain mismatch/);
 const methods=JSON.parse(compose('exec','-T','source','node','-e',"fetch('http://127.0.0.1:8080/stats').then(r=>r.text()).then(console.log)"));assert.ok(methods.length>0);assert.ok(methods.every(m=>m==='eth_chainId'),'wrong-chain keeper must never send');
 console.log('PASS: container indexer proof and restart persistence; non-root/read-only keeper; credentials mounted read-only; wrong-chain RPC produced no writes.');
}finally{try{compose('--profile','keeper','down','--volumes','--remove-orphans');}finally{fs.rmSync(temp,{recursive:true,force:true});}}
