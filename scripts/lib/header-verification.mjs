// Independent reference: intentionally does not import the production Bitcoin step/encoder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const digest = b => createHash('sha256').update(b).digest();
export const rawHash = b => digest(digest(b));
export const displayHash = b => Buffer.from(rawHash(b)).reverse().toString('hex');
export function encode(b) {
  assert.match(b.id, /^[0-9a-f]{64}$/); assert.match(b.previousblockhash, /^[0-9a-f]{64}$/);
  assert.match(b.merkle_root, /^[0-9a-f]{64}$/);
  const h = Buffer.alloc(80);
  for (const key of ['height','version','timestamp','bits','nonce']) assert.ok(Number.isSafeInteger(b[key]), key);
  assert.ok(b.height>=0 && b.version>=-2147483648 && b.version<=4294967295);
  h.writeUInt32LE(b.version >>> 0); Buffer.from(b.previousblockhash,'hex').reverse().copy(h,4);
  Buffer.from(b.merkle_root,'hex').reverse().copy(h,36);
  for (const [key,offset] of [['timestamp',68],['bits',72],['nonce',76]]) h.writeUInt32LE(b[key],offset);
  assert.equal(displayHash(h), b.id, `metadata encoding at ${b.height}`); return h;
}
const limit = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
export function target(bits) {
  const exp=bits>>>24, mant=bits&0x7fffff;
  assert.ok(!(bits&0x800000) && mant && exp<=34, 'invalid compact target');
  assert.ok(!(mant>0xff && exp>33) && !(mant>0xffff && exp>32), 'compact overflow');
  const n=exp<=3 ? BigInt(mant)>>BigInt(8*(3-exp)) : BigInt(mant)<<BigInt(8*(exp-3)); assert.ok(n<=limit && n>0n); return n;
}
function compact(n) {
  let size=Math.ceil(n.toString(16).length/2), m=Number(size<=3 ? n<<BigInt(8*(3-size)) : n>>BigInt(8*(size-3)));
  if(m&0x800000){m>>>=8;size++;} return (size*0x1000000+m)>>>0;
}
export function replay(headers, anchor, endHeight, now) {
  let previous=headers.get(anchor.anchorHeight), bits=previous.readUInt32LE(72), epochStart=anchor.epochStart;
  let times=anchor.ancestorTimes.slice(), u=0n, work=0n, finalized; const retargets=[];
  assert.equal(displayHash(previous),anchor.anchorHash);
  assert.deepEqual(Array.from({length:11},(_,i)=>headers.get(anchor.anchorHeight-10+i).readUInt32LE(68)),times);
  for(let h=anchor.genesisHeight;h<=endHeight+100;h++){
    const b=headers.get(h); assert.ok(b,`missing ${h}`); assert.equal(b.length,80);
    assert.ok(b.subarray(4,36).equals(rawHash(previous)),`link ${h}`);
    const time=b.readUInt32LE(68), nextBits=b.readUInt32LE(72);
    assert.ok(time>[...times].sort((a,b)=>a-b)[5],`MTP ${h}`); assert.ok(time<=now+7200,`future ${h}`);
    if(h%2016===0){
      const span=Math.max(302400,Math.min(4838400,previous.readUInt32LE(68)-epochStart));
      const next=target(bits)*BigInt(span)/1209600n;
      assert.equal(nextBits,compact(next>limit?limit:next),`retarget ${h}`);
      epochStart=time; retargets.push(h);
    } else assert.equal(nextBits,bits,`difficulty ${h}`);
    assert.ok(BigInt('0x'+displayHash(b))<=target(nextBits),`PoW ${h}`);
    const r=digest(rawHash(b)); u+=BigInt(r.reduce((s,v)=>s+v,0)-4080);
    work+=(1n<<256n)/(target(nextBits)+1n); times=[...times.slice(1),time]; bits=nextBits; previous=b;
    if(h===endHeight) finalized={hash:'0x'+rawHash(b).toString('hex'),height:h,bits,time,epochStart,u:u.toString(),times:[...times],work:work.toString(),S_wad:(u*12000000000000n).toString()};
  }
  return {finalized,retargets,descendantCount:100};
}
export function decodeContinuity(hex) {
  assert.equal(hex.length,2+18*64); const words=Array.from({length:18},(_,i)=>'0x'+hex.slice(2+i*64,66+i*64));
  const v=BigInt(words[5]), signed=v>=(1n<<255n)?v-(1n<<256n):v;
  return {hash:words[0],height:Number(BigInt(words[1])),bits:Number(BigInt(words[2])),time:Number(BigInt(words[3])),epochStart:Number(BigInt(words[4])),u:signed.toString(),times:words.slice(6,17).map(v=>Number(BigInt(v))),work:BigInt(words[17]).toString(),S_wad:(signed*12000000000000n).toString()};
}
