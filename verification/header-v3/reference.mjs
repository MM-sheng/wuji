// Portable reference implementation. Does not import production modules, a wallet, or a signer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keccak256 } from './keccak.mjs';

export const sha256 = data => createHash('sha256').update(data).digest();
export const hashHex = data => sha256(data).toString('hex');
export const rawHash = data => sha256(sha256(data));
export const displayHash = data => Buffer.from(rawHash(data)).reverse().toString('hex');
export const word = v => BigInt.asUintN(256,BigInt(v)).toString(16).padStart(64,'0');
export const selector = signature => '0x'+keccak256(Buffer.from(signature)).subarray(0,4).toString('hex');
export function hexBytes(hex) {
  assert.match(hex,/^0x(?:[0-9a-f]{2})*$/i,'invalid hex bytes');
  return Buffer.from(hex.slice(2),'hex');
}
export function scalar(hex, signed=false) {
  assert.match(hex,/^0x[0-9a-f]{64}$/i,'expected one ABI word');
  return signed ? BigInt.asIntN(256,BigInt(hex)) : BigInt(hex);
}
export function decodeContinuity(hex) {
  assert.match(hex,/^0x[0-9a-f]{1152}$/i,'expected 18 continuity words');
  const w = Array.from({length:18},(_,i)=>'0x'+hex.slice(2+64*i,66+64*i));
  const u = scalar(w[5],true);
  return {hash:w[0].toLowerCase(),height:Number(scalar(w[1])),bits:Number(scalar(w[2])),
    time:Number(scalar(w[3])),epochStart:Number(scalar(w[4])),u:u.toString(),
    times:w.slice(6,17).map(v=>Number(scalar(v))),work:scalar(w[17]).toString(),S_wad:(u*12000000000000n).toString()};
}
export function anchorCommitment(c) {
  const a=c.anchor,b=hexBytes(a.anchorHeader);
  const fields=[rawHash(b).toString('hex'),...[
    a.anchorHeight,b.readUInt32LE(72),b.readUInt32LE(68),a.epochStart,0,...a.ancestorTimes,c.anchorWork,
  ].map(word)];
  return '0x'+keccak256(Buffer.from(fields.join(''),'hex')).toString('hex');
}
export function calls(c) {
  for (const [sig,expected] of Object.entries(c.selectors)) assert.equal(selector(sig),expected,`selector ${sig}`);
  return Object.fromEntries(Object.entries(c.selectors).map(([sig,data])=>[sig,
    data+(sig==='committedAt(uint64)'?word(c.anchor.anchorHeight):sig.includes('(uint64)')?word(c.expected.firstCheckpoint):'')]));
}
export function checkRpcEvidence(e,c) {
  assert.equal(BigInt(e.chainId),BigInt(c.chainId),'chain ID');
  for (const b of [e.blockBefore,e.blockAfter]) {
    assert.equal(b.number,c.block.number,'EVM block number');
    assert.equal(b.hash,c.block.hash,'EVM block hash');
    assert.equal(b.timestamp,c.block.timestamp,'EVM block time');
  }
  assert.ok(BigInt(e.finalized.number)>=BigInt(c.block.number),'fixture not finalized at RPC');
  assert.equal(hashHex(hexBytes(e.code)),c.runtimeSha256,'index runtime SHA-256');
  assert.deepEqual(Object.keys(e.reads).sort(),Object.keys(calls(c)).sort(),'view coverage');
  assert.deepEqual(decodeContinuity(e.reads['continuity()']),c.expected.continuity,'pinned continuity');
  const values={'S()':c.expected.continuity.S_wad,'lastHeight()':c.expected.continuity.height,
    'CONFIRMATIONS()':c.confirmations,'frozen()':0,'seenHeight()':c.expected.seenHeight,
    'seenTime()':c.expected.seenTime,'GENESIS_HEIGHT()':c.anchor.genesisHeight,
    'CHECKPOINT_INTERVAL()':c.checkpointInterval,'UNIT()':c.unit,'MEAN()':c.mean,
    'REORG_MARGIN()':c.reorgMargin,'checkpointed(uint64)':0,'checkpointS(uint64)':0};
  for (const [sig,value] of Object.entries(values)) assert.equal(scalar(e.reads[sig],sig==='S()'),BigInt(value),sig);
  assert.equal(e.reads['lastHash()'],c.expected.continuity.hash,'last hash');
  assert.equal(e.reads['committedAt(uint64)'],anchorCommitment(c),'anchor context commitment');
  assert.equal(e.reads['rewards()'],'0x'+c.rewards.slice(2).toLowerCase().padStart(64,'0'),'rewards binding');
}
export function encodeMetadata(b) {
  for (const key of ['id','previousblockhash','merkle_root']) assert.match(b[key],/^[0-9a-f]{64}$/);
  for (const key of ['height','version','timestamp','bits','nonce']) assert.ok(Number.isSafeInteger(b[key]),key);
  assert.ok(b.height>=0 && b.version>=-2147483648 && b.version<=4294967295,'version/height range');
  const raw=Buffer.alloc(80);raw.writeUInt32LE(b.version>>>0);
  Buffer.from(b.previousblockhash,'hex').reverse().copy(raw,4);
  Buffer.from(b.merkle_root,'hex').reverse().copy(raw,36);
  for (const [key,at] of [['timestamp',68],['bits',72],['nonce',76]]) raw.writeUInt32LE(b[key],at);
  assert.equal(displayHash(raw),b.id,`metadata hash at ${b.height}`);
  return raw;
}
const LIMIT=(1n<<224n)-1n;
export function target(bits) {
  const size=bits>>>24,mant=bits&0x7fffff;
  assert.ok(!(bits&0x800000)&&mant&&size<=34,'compact sign/zero/size');
  assert.ok(!(mant>0xff&&size>33)&&!(mant>0xffff&&size>32),'compact overflow');
  const n=size<=3?BigInt(mant)>>BigInt(8*(3-size)):BigInt(mant)<<BigInt(8*(size-3));
  assert.ok(n>0n&&n<=LIMIT,'target range');return n;
}
function compact(n) {
  let size=Math.ceil(n.toString(16).length/2),mant=Number(size<=3?n<<BigInt(8*(3-size)):n>>BigInt(8*(size-3)));
  if (mant&0x800000) {mant>>>=8;size++;} return (size*0x1000000+mant)>>>0;
}
export function replay(bytes,c) {
  const a=c.anchor,start=a.epochFirst,end=c.expected.seenHeight,finalHeight=c.expected.continuity.height;
  assert.equal(bytes.length,(end-start+1)*80,'header coverage/length');
  assert.equal(start%2016,0,'bootstrap epoch boundary');
  assert.equal(a.genesisHeight,a.anchorHeight+1,'genesis adjacency');
  assert.equal(end-finalHeight,c.confirmations,'confirmation suffix');
  const at=h=>bytes.subarray((h-start)*80,(h-start+1)*80);
  assert.ok(at(a.anchorHeight).equals(hexBytes(a.anchorHeader)),'anchor bytes');
  assert.equal(displayHash(at(a.anchorHeight)),a.anchorHash,'anchor hash');
  assert.equal(at(start).readUInt32LE(68),a.epochStart,'anchor epoch start');
  assert.deepEqual(Array.from({length:11},(_,i)=>at(a.anchorHeight-10+i).readUInt32LE(68)),a.ancestorTimes,'anchor time window');
  let previous,bits,epochStart=a.epochStart,times=[],u=0n,work=BigInt(c.anchorWork),finalized;
  const series=[],retargets=[];
  for (let h=start;h<=end;h++) {
    const b=at(h),time=b.readUInt32LE(68),nextBits=b.readUInt32LE(72),t=target(nextBits);
    assert.ok(b.readInt32LE(0)>=4,`Bitcoin version floor ${h}`);
    if (previous) assert.ok(b.subarray(4,36).equals(rawHash(previous)),`link ${h}`);
    if (times.length===11) assert.ok(time>[...times].sort((x,y)=>x-y)[5],`MTP ${h}`);
    assert.ok(time<=Number(BigInt(c.block.timestamp))+7200,`future time ${h}`);
    if (previous && h%2016===0) {
      const span=Math.max(302400,Math.min(4838400,previous.readUInt32LE(68)-epochStart));
      const next=target(bits)*BigInt(span)/1209600n;
      assert.equal(nextBits,compact(next>LIMIT?LIMIT:next),`retarget ${h}`);
      epochStart=time;retargets.push(h);
    } else if (previous) assert.equal(nextBits,bits,`difficulty ${h}`);
    assert.ok(BigInt('0x'+displayHash(b))<=t,`PoW ${h}`);
    times=[...times.slice(-10),time];bits=nextBits;previous=b;
    if (h>=a.genesisHeight) {
      const delta=sha256(rawHash(b)).reduce((n,v)=>n+v,0)-c.mean;
      u+=BigInt(delta);work+=(1n<<256n)/(t+1n);
      assert.ok(u>=-(1n<<63n)&&u<(1n<<63n),`int64 U ${h}`);
      if (h<=finalHeight) series.push({height:h,hash:displayHash(b),delta,U:u.toString(),S_wad:(u*BigInt(c.unit)).toString()});
    }
    if (h===finalHeight) finalized={hash:'0x'+rawHash(b).toString('hex'),height:h,bits,time,epochStart,
      u:u.toString(),times:[...times],work:work.toString(),S_wad:(u*BigInt(c.unit)).toString()};
  }
  assert.deepEqual(finalized,c.expected.continuity,'replayed continuity');
  assert.equal(at(end).readUInt32LE(68),c.expected.seenTime,'seen time');
  const span=bytes.subarray((c.expected.spanFrom-start)*80,(c.expected.spanTo-start+1)*80);
  assert.equal(hashHex(span),c.expected.spanSha256,'previous public range digest');
  return {finalized,retargets,series,from:start,to:end,headers:bytes.length/80,
    firstCheckpoint:c.expected.firstCheckpoint,checkpointStatus:'NOT_REACHED'};
}
export const serializeSeries = rows => rows.map(v=>JSON.stringify(v)).join('\n')+'\n';
