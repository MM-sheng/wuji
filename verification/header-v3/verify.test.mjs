// Run without arguments for offline vectors. Add a completed public archive for recovery/failure tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {keccak256} from './keccak.mjs';
import {sha256,rawHash,displayHash,hashHex,word,calls,anchorCommitment,encodeMetadata,target,
  decodeContinuity,checkRpcEvidence,replay} from './reference.mjs';
import {PACKAGE,candidate,makeRpc,readRpc,endpoint,verifyArchive,download} from './verify.mjs';

const vector=JSON.parse(fs.readFileSync(path.join(PACKAGE,'vector.json')));
const raw=Buffer.from(vector.headerHex,'hex');
test('public height 800000 vector pins raw/display order, R and integer increment',()=>{
  assert.equal(displayHash(raw),vector.displayHash);assert.equal(rawHash(raw).toString('hex'),vector.rawHash);
  const r=sha256(rawHash(raw));assert.equal(r.toString('hex'),vector.R);
  const delta=r.reduce((n,v)=>n+v,0)-4080;assert.equal(delta,vector.delta);
  assert.equal((BigInt(delta)*12000000000000n).toString(),vector.deltaS_wad);
  assert.notEqual(sha256(Buffer.from(vector.displayHash,'hex')).toString('hex'),vector.R);
});
test('metadata encoding checks advertised block hash and malformed fields',()=>{
  const metadata={height:vector.height,id:vector.displayHash,version:raw.readUInt32LE(0),
    previousblockhash:Buffer.from(raw.subarray(4,36)).reverse().toString('hex'),
    merkle_root:Buffer.from(raw.subarray(36,68)).reverse().toString('hex'),
    timestamp:raw.readUInt32LE(68),bits:raw.readUInt32LE(72),nonce:raw.readUInt32LE(76)};
  assert.ok(encodeMetadata(metadata).equals(raw));
  assert.throws(()=>encodeMetadata({...metadata,nonce:metadata.nonce+1}),/metadata hash/);
  assert.throws(()=>encodeMetadata({...metadata,bits:-1}));
});
test('Ethereum Keccak padding, ABI selectors and multi-block anchor commitment match fixed vectors',()=>{
  assert.equal(keccak256(Buffer.alloc(0)).toString('hex'),'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(Buffer.from('abc')).toString('hex'),'4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(Object.keys(calls(candidate)).length,17);
  assert.equal(anchorCommitment(candidate),'0x4f535aae6373759f9c7a15446b24465e313603874f00b72b579182e40f72086f');
});
test('compact targets reject sign, zero, overflow and excess target',()=>{
  for(const bits of [0,0x1d80ffff,0x2100ffff,0x1e00ffff])assert.throws(()=>target(bits));
  assert.equal(target(0x1d00ffff),0xffffn<<208n);
});
test('signed ABI U is decoded exactly and truncated continuity fails',()=>{
  const words=Array(18).fill(word(0));words[5]=word(-1);
  const state=decodeContinuity('0x'+words.join(''));
  assert.equal(state.u,'-1');assert.equal(state.S_wad,'-12000000000000');
  assert.throws(()=>decodeContinuity('0x'));
});
test('RPC rejects write methods and non-allowlisted calls before any network request',async()=>{
  let requests=0;const rpc=makeRpc('https://example.invalid',candidate,async()=>{requests++;throw Error('should not fetch');});
  await assert.rejects(()=>rpc('eth_sendRawTransaction',['0x']),/read-only/);
  await assert.rejects(()=>rpc('eth_call',[{to:candidate.index,data:'0xdeadbeef'},candidate.block.number]),/allowlisted/);
  await assert.rejects(()=>rpc('eth_getBlockByNumber',['latest',false]),/fixed/);
  assert.equal(requests,0);
});
test('endpoint configuration excludes URL credentials and insecure remote transport',()=>{
  assert.throws(()=>endpoint('https://user:secret@example.invalid'));
  assert.throws(()=>endpoint('https://example.invalid/?token=secret'));
  assert.throws(()=>endpoint('http://example.invalid'));
  assert.equal(endpoint('http://127.0.0.1:8545/'),'http://127.0.0.1:8545');
});

for(const [name,status,header,hint] of [
  ['delta seconds',429,'3600',/wait at least 3600 seconds/],
  ['HTTP date',429,'Fri, 23 Oct 2026 12:00:00 GMT',/not manually resume before Fri, 23 Oct 2026 12:00:00 GMT/],
  ['missing header',429,null,/provider cooldown/],
  ['invalid header',429,'not a valid wait',/provider cooldown/],
  ['service unavailable with cooldown',503,'3600',/wait at least 3600 seconds/],
])test(`provider cooldown stops without automatic retry: ${name}`,async()=>{
  let requests=0,cancelled=0;
  const rpc=makeRpc('https://example.invalid',candidate,async()=>{
    requests++;return {ok:false,status,headers:{get:()=>header},body:{cancel:async()=>{
      cancelled++;if(name==='delta seconds')throw Error('simulated body cancellation failure');
    }}};
  });
  await assert.rejects(()=>rpc('eth_chainId',[]),error=>{
    assert.match(error.message,/request stopped without automatic retry/);assert.match(error.message,hint);return true;
  });
  assert.equal(requests,1,'cooldown must not trigger a second HTTP request');assert.equal(cancelled,1);
});

for(const file of ['source.json','rpc.json'])test(`truncated local ${file} stays unchanged and refuses repeated resume before network`,async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-partial-local-'));
  const originalFetch=globalThis.fetch;let requests=0;
  try {
    const out=path.join(dir,'archive');fs.mkdirSync(out);
    const config={candidateId:candidate.id,candidateSha256:hashHex(fs.readFileSync(path.join(PACKAGE,'candidate.json'))),
      rpc:candidate.defaults.rpc,bitcoinApi:candidate.defaults.bitcoinApi};
    fs.writeFileSync(path.join(out,'source.json'),JSON.stringify(config));
    const broken=path.join(out,file),bytes=Buffer.from('{"partial":');fs.writeFileSync(broken,bytes);
    globalThis.fetch=async()=>{requests++;throw Error('unexpected network access');};
    for(let attempt=0;attempt<2;attempt++) {
      await assert.rejects(()=>download(out),error=>{
        assert.ok(error.message.includes(`invalid JSON evidence: ${file}`));
        assert.match(error.message,/preserve this directory.*fetch into a new directory/);return true;
      });
      assert.ok(fs.readFileSync(broken).equals(bytes));assert.equal(fs.existsSync(path.join(out,'result.json')),false);
    }
    assert.equal(requests,0);
  } finally {globalThis.fetch=originalFetch;fs.rmSync(dir,{recursive:true,force:true});}
});

// Only public, non-signing fixture values are used by the mock transport.
const fake=structuredClone(candidate);fake.runtimeSha256=hashHex(Buffer.from('00','hex'));
function views(c) {
  const s=c.expected.continuity;
  const values={'S()':s.S_wad,'lastHeight()':s.height,'CONFIRMATIONS()':100,'frozen()':0,
    'seenHeight()':c.expected.seenHeight,'seenTime()':c.expected.seenTime,'GENESIS_HEIGHT()':c.anchor.genesisHeight,
    'CHECKPOINT_INTERVAL()':4320,'UNIT()':c.unit,'MEAN()':4080,'REORG_MARGIN()':144,
    'checkpointed(uint64)':0,'checkpointS(uint64)':0};
  return {...Object.fromEntries(Object.entries(values).map(([k,v])=>[k,'0x'+word(v)])),
    'continuity()':s.hash+[s.height,s.bits,s.time,s.epochStart,s.u,...s.times,s.work].map(word).join(''),
    'lastHash()':s.hash,'rewards()':'0x'+word(BigInt(c.rewards)),'committedAt(uint64)':anchorCommitment(c)};
}
function mock(change=()=>{}) {
  let blockReads=0;const readByData=Object.fromEntries(Object.entries(calls(fake)).map(([sig,data])=>[data,views(fake)[sig]]));
  return async (_url,options)=>{
    const req=JSON.parse(options.body);let result;
    if(req.method==='eth_chainId')result='0xaa36a7';
    if(req.method==='eth_getCode')result='0x00';
    if(req.method==='eth_call')result=readByData[req.params[0].data];
    if(req.method==='eth_getBlockByNumber'){result={...fake.block};if(req.params[0]!=='finalized')blockReads++;}
    const answer={jsonrpc:'2.0',id:req.id,result};change(answer,req,blockReads);
    return {ok:true,text:async()=>JSON.stringify(answer)};
  };
}
test('fixed-block RPC evidence checks every identity field',async()=>{
  const e=await readRpc('https://example.invalid',fake,mock());checkRpcEvidence(e,fake);
  for(const sig of ['S()','CONFIRMATIONS()','committedAt(uint64)','checkpointed(uint64)']) {
    const changed=structuredClone(e);changed.reads[sig]='0x'+word(42);
    assert.throws(()=>checkRpcEvidence(changed,fake),{code:'ERR_ASSERTION'},`invalid ${sig} must be rejected`);
  }
});
test('RPC refuses wrong chain, changed canonical block and wrong deployed code',async()=>{
  await assert.rejects(()=>readRpc('https://example.invalid',fake,mock((a,r)=>{if(r.method==='eth_chainId')a.result='0x1';})),/chain ID/);
  await assert.rejects(()=>readRpc('https://example.invalid',fake,mock((a,r,n)=>{if(r.method==='eth_getBlockByNumber'&&n===2)a.result.hash='0x'+'00'.repeat(32);})),/block hash/);
  await assert.rejects(()=>readRpc('https://example.invalid',fake,mock((a,r)=>{if(r.method==='eth_getCode')a.result='0x01';})),/runtime/);
});

const archive=process.argv[2];
test('complete offline replay and header-rule counterexamples',{skip:!archive},()=>{
  const result=verifyArchive(archive);assert.equal(result.bitcoin.finalized.S_wad,'3516000000000000');
  assert.equal(result.bitcoin.headers,4931);assert.equal(result.rows,2965);
  const config=JSON.parse(fs.readFileSync(path.join(archive,'source.json')));
  assert.deepEqual(result.sources,{rpc:config.rpc,bitcoinApi:config.bitcoinApi,labelConsistency:'CHECKED',authenticity:'NOT_ATTESTED'});
  assert.equal(result.operatorIndependence,'NOT_ATTESTED');
  for(const file of ['source.json','rpc.json','pages.json','final-block.json'])
    assert.equal(result.evidenceSha256[file],hashHex(fs.readFileSync(path.join(archive,file))));
  const bytes=fs.readFileSync(path.join(archive,'headers.bin')),first=candidate.anchor.genesisHeight;
  for(const [height,change,pattern] of [
    [first,b=>{b[4]^=1;},/link/],
    [first,b=>b.writeUInt32LE(1,68),/MTP/],
    [first,b=>b.writeUInt32LE(Number(BigInt(candidate.block.timestamp))+7201,68),/future time/],
    [first,b=>b.writeUInt32LE(b.readUInt32LE(72)+1,72),/difficulty/],
    [969696,b=>b.writeUInt32LE(b.readUInt32LE(72)+1,72),/retarget/],
    [first,b=>{b[76]^=1;},/PoW/],
    [first,b=>b.writeInt32LE(3,0),/version floor/],
  ]) {
    const copy=Buffer.from(bytes),offset=(height-candidate.anchor.epochFirst)*80;
    change(copy.subarray(offset,offset+80));assert.throws(()=>replay(copy,candidate),pattern);
  }
  assert.throws(()=>replay(bytes.subarray(80),candidate),/coverage/);
  assert.throws(()=>replay(bytes,{...candidate,confirmations:101}),/confirmation suffix/);
});
for(const kind of ['missing page','truncated page JSON','changed header','changed RPC state','changed consumer series',
  'changed source RPC','changed evidence RPC','changed Bitcoin source','changed page URL','invalid observation']) {
  test(`offline recovery rejects ${kind}`,{skip:!archive},()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-public-negative-'));
    try {
      const copy=path.join(dir,'archive');fs.cpSync(archive,copy,{recursive:true});
      if(kind==='missing page')fs.unlinkSync(path.join(copy,'pages',fs.readdirSync(path.join(copy,'pages'))[0]));
      if(kind==='truncated page JSON')fs.writeFileSync(path.join(copy,'pages',fs.readdirSync(path.join(copy,'pages'))[0]),'[{"height":');
      if(kind==='changed header') {const file=path.join(copy,'headers.bin'),b=fs.readFileSync(file);b[80]^=1;fs.writeFileSync(file,b);}
      if(kind==='changed RPC state') {const file=path.join(copy,'rpc.json'),e=JSON.parse(fs.readFileSync(file));e.reads['S()']='0x'+word(1);fs.writeFileSync(file,JSON.stringify(e));}
      if(kind==='changed consumer series')fs.appendFileSync(path.join(copy,'series.ndjson'),'{}\n');
      if(kind==='changed source RPC'||kind==='changed Bitcoin source') {
        const file=path.join(copy,'source.json'),value=JSON.parse(fs.readFileSync(file));
        value[kind==='changed source RPC'?'rpc':'bitcoinApi']='https://different.example.invalid';
        fs.writeFileSync(file,JSON.stringify(value));
      }
      if(kind==='changed evidence RPC'||kind==='invalid observation') {
        const file=path.join(copy,'rpc.json'),value=JSON.parse(fs.readFileSync(file));
        if(kind==='changed evidence RPC')value.rpc='https://different.example.invalid';
        else value.observedAt='not a timestamp';
        fs.writeFileSync(file,JSON.stringify(value));
      }
      if(kind==='changed page URL') {
        const file=path.join(copy,'pages.json'),value=JSON.parse(fs.readFileSync(file));
        value[0].url='https://different.example.invalid/972610';fs.writeFileSync(file,JSON.stringify(value));
      }
      assert.throws(()=>verifyArchive(copy));
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
}

test('interrupted download resumes verified pages without overwriting a completed archive',{skip:!archive},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-public-resume-'));
  const originalFetch=globalThis.fetch,originalTimer=globalThis.setTimeout;
  try {
    const evidence=JSON.parse(fs.readFileSync(path.join(archive,'rpc.json')));
    const pages=JSON.parse(fs.readFileSync(path.join(archive,'pages.json')));
    const failingHeight=pages[3].height,requested=[];
    const readByData=Object.fromEntries(Object.entries(calls(candidate)).map(([sig,data])=>[data,evidence.reads[sig]]));
    let interrupted=true,limited=false,requestCount=0;
    // The public archive supplies response fixtures. No HTTP is sent; only retry/page timers are shortened.
    globalThis.setTimeout=(callback,ms,...args)=>originalTimer(callback,ms===1000||ms===2000?0:ms,...args);
    globalThis.fetch=async(url,options)=>{
      requestCount++;
      if(options.method==='POST') {
        assert.equal(url,candidate.defaults.rpc);
        const req=JSON.parse(options.body);let result;
        if(req.method==='eth_chainId')result=evidence.chainId;
        else if(req.method==='eth_getCode')result=evidence.code;
        else if(req.method==='eth_call')result=readByData[req.params[0].data];
        else if(req.method==='eth_getBlockByNumber')result=req.params[0]==='finalized'?evidence.finalized:evidence.blockBefore;
        else assert.fail('unexpected RPC method');
        return {ok:true,text:async()=>JSON.stringify({jsonrpc:'2.0',id:req.id,result})};
      }
      const prefix=candidate.defaults.bitcoinApi+'/v1/blocks/';assert.ok(url.startsWith(prefix));
      const height=Number(url.slice(prefix.length));requested.push(height);
      if(limited&&height===failingHeight)return {ok:false,status:429,headers:{get:()=> '3600'}};
      if(interrupted&&height===failingHeight)throw Error('simulated transport interruption');
      return {ok:true,text:async()=>fs.readFileSync(path.join(archive,'pages',`${height}.json`),'utf8')};
    };
    const out=path.join(dir,'download');
    await assert.rejects(()=>download(out),/simulated transport interruption/);
    assert.equal(fs.readdirSync(path.join(out,'pages')).length,3);
    assert.equal(fs.existsSync(path.join(out,'result.json')),false);
    const saved=pages.slice(0,3).map(p=>fs.readFileSync(path.join(out,'pages',p.file)));
    await assert.rejects(()=>download(out,{rpc:'https://different.example.invalid'}),/resume configuration differs/);
    const rpcFile=path.join(out,'rpc.json'),savedRpc=fs.readFileSync(rpcFile),mislabeled=JSON.parse(savedRpc);
    mislabeled.rpc='https://different.example.invalid';fs.writeFileSync(rpcFile,JSON.stringify(mislabeled));
    const before=requestCount;
    await assert.rejects(()=>download(out),/RPC source differs/);
    assert.equal(requestCount,before,'inconsistent cached evidence must fail before network access');
    fs.writeFileSync(rpcFile,savedRpc);
    interrupted=false;
    limited=true;
    await assert.rejects(()=>download(out),/HTTP 429.*stopped without automatic retry.*3600 seconds/);
    assert.equal(requested.filter(h=>h===failingHeight).length,4,'three transport failures then exactly one limited request');
    assert.equal(fs.existsSync(path.join(out,'result.json')),false);
    assert.equal(fs.readdirSync(path.join(out,'pages')).length,3);
    for(let i=0;i<3;i++)assert.ok(fs.readFileSync(path.join(out,'pages',pages[i].file)).equals(saved[i]));
    limited=false;
    const result=await download(out);
    assert.equal(result.status,'PASS_PUBLIC_REPLAY');
    assert.equal(result.bitcoin.finalized.S_wad,'3516000000000000');
    assert.equal(result.sources.labelConsistency,'CHECKED');
    assert.equal(result.sources.authenticity,'NOT_ATTESTED');
    assert.equal(verifyArchive(out).status,'PASS_OFFLINE_REPLAY');
    for(let i=0;i<3;i++) {
      assert.ok(fs.readFileSync(path.join(out,'pages',pages[i].file)).equals(saved[i]));
      assert.equal(requested.filter(h=>h===pages[i].height).length,1,'cached page fetched again');
    }
    assert.equal(requested.filter(h=>h===failingHeight).length,5,'three failures, one limited request, then one successful manual resume');
    const completed=fs.readFileSync(path.join(out,'result.json'));
    await assert.rejects(()=>download(out),/completed archive/);
    assert.ok(fs.readFileSync(path.join(out,'result.json')).equals(completed));
  } finally {
    globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimer;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
