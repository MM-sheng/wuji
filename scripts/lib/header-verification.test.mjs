import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encode, replay, displayHash, digest, rawHash, decodeContinuity, target } from './header-verification.mjs';
const fixtures=new URL('../../contracts/test/fixtures/',import.meta.url);
const bytes=Buffer.from(fs.readFileSync(new URL('bitcoin-798336.hex',fixtures),'utf8').trim().slice(2),'hex');
const headers=new Map(Array.from({length:bytes.length/80},(_,i)=>[798336+i,bytes.subarray(i*80,(i+1)*80)]));
const h=headers.get(800000);
const metadata={height:800000,id:'00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054',version:h.readUInt32LE(0),previousblockhash:Buffer.from(h.subarray(4,36)).reverse().toString('hex'),merkle_root:Buffer.from(h.subarray(36,68)).reverse().toString('hex'),timestamp:h.readUInt32LE(68),bits:h.readUInt32LE(72),nonce:h.readUInt32LE(76)};
const anchor={anchorHeight:798346,genesisHeight:798347,anchorHash:displayHash(headers.get(798346)),epochStart:headers.get(798336).readUInt32LE(68),ancestorTimes:Array.from({length:11},(_,i)=>headers.get(798336+i).readUInt32LE(68))};
const run=map=>replay(map,anchor,800263,2000000000);
test('independent encoder reproduces known height 800000, digest byte order and R',()=>{
 assert.deepEqual(encode(metadata),h);assert.equal(digest(rawHash(h)).toString('hex'),'74323d1b46bfc56d162ea5725ebc666028c5ee2b0a4824e32dedff53fe3ec1fd');
 assert.throws(()=>encode({...metadata,previousblockhash:Buffer.from(h.subarray(4,36)).toString('hex')}),/encoding/);
 assert.throws(()=>encode({...metadata,nonce:metadata.nonce+1}),/encoding/);
});
test('real committed headers cross a retarget with exact committed R vectors',()=>{
 const result=run(headers);assert.deepEqual(result.retargets,[800352]);
 const vectors=fs.readFileSync(new URL('bitcoin-vectors.hex',fixtures),'utf8').trim().slice(2);let u=0n;
 for(let height=anchor.genesisHeight;height<=800263;height++){const i=height-798336,r=Buffer.from(vectors.slice(i*64,(i+1)*64),'hex');u+=BigInt(r.reduce((a,v)=>a+v,0)-4080);}
 assert.equal(result.finalized.u,u.toString());assert.equal(result.finalized.S_wad,(u*12000000000000n).toString());assert.equal(result.descendantCount,100);
});
for(const [name,height,change,pattern] of [
 ['missing',798400,()=>null,/missing/],['link',798400,b=>{b[4]^=1;},/link/],
 ['MTP',798347,b=>b.writeUInt32LE(1,68),/MTP/],['future',798347,b=>b.writeUInt32LE(2100000000,68),/future/],
 ['difficulty',798347,b=>b.writeUInt32LE(0x1d00ffff,72),/difficulty/],
 ['retarget',800352,b=>b.writeUInt32LE(b.readUInt32LE(72)+1,72),/retarget/],
 ['PoW',798347,b=>{b[76]^=1;},/PoW/]
])test(`reference rejects ${name}`,()=>{const copy=new Map(headers),b=Buffer.from(headers.get(height));if(change(b)===null)copy.delete(height);else copy.set(height,b);assert.throws(()=>run(copy),pattern);});
test('continuity decoding preserves negative signed U and rejects truncated response',()=>{
 const word=v=>BigInt(v).toString(16).padStart(64,'0');const words=Array(18).fill(word(0));words[5]=word((1n<<256n)-1n);
 const result=decodeContinuity('0x'+words.join(''));assert.equal(result.u,'-1');assert.equal(result.S_wad,'-12000000000000');assert.throws(()=>decodeContinuity('0x'));
});
test('target rejects negative, zero, overflowing and excessive proof of work targets',()=>{
 for(const n of [0,0x1d80ffff,0x2100ffff,0x1e00ffff])assert.throws(()=>target(n));assert.equal(target(0x1d00ffff),0xffffn<<208n);
});
