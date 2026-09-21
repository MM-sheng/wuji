import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('IPFS publisher stages only index.html, requires a recursive pin and checks retrieved bytes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji publish '));
 try{
  fs.mkdirSync(path.join(dir,'scripts'));fs.mkdirSync(path.join(dir,'apps/terminal'),{recursive:true});
  fs.copyFileSync(new URL('./publish-ipfs.sh',import.meta.url),path.join(dir,'scripts/publish-ipfs.sh'));
  fs.writeFileSync(path.join(dir,'apps/terminal/index.html'),'<html>public</html>');fs.writeFileSync(path.join(dir,'apps/terminal/do-not-publish.test.mjs'),'private marker');
  const fake=path.join(dir,'fake-ipfs');fs.writeFileSync(fake,`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),a=process.argv.slice(2),store=process.env.FAKE_STORE;
if(a[0]==='add'){const stage=a.at(-1);if(JSON.stringify(fs.readdirSync(stage))!==JSON.stringify(['index.html']))process.exit(4);fs.copyFileSync(path.join(stage,'index.html'),store);console.log('bafytestcid');}
else if(a[0]==='pin'){if(process.env.FAKE_FAIL==='pin')process.exit(5);if(a.join(' ')!=='pin ls --type=recursive bafytestcid')process.exit(6);}
else if(a[0]==='cat'){process.stdout.write(process.env.FAKE_FAIL==='bytes'?'incorrect':fs.readFileSync(store));}
else process.exit(7);
`,{mode:0o755});
  const run=mode=>spawnSync('/bin/bash',[path.join(dir,'scripts/publish-ipfs.sh')],{encoding:'utf8',env:{...process.env,IPFS_BIN:fake,FAKE_STORE:path.join(dir,'pinned'),FAKE_FAIL:mode}});
  const ok=run('');assert.equal(ok.status,0,ok.stderr);assert.equal(ok.stdout.trim(),'bafytestcid');assert.notEqual(run('pin').status,0);assert.notEqual(run('bytes').status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
