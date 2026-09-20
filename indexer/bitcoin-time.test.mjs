import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {step} from './bitcoin.mjs';
const read=name=>fs.readFileSync(new URL('../contracts/test/fixtures/'+name,import.meta.url),'utf8');
test('timestamp predicates match 345 vectors generated from the compiled Core median',()=>{
 const fixture=JSON.parse(read('core-timestamps.json'));assert.equal(fixture.coreCommit,'d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3');
 assert.equal(fixture.vectors.length,345);
 for(const v of fixture.vectors){const median=[...v.times].sort((a,b)=>a-b)[5];assert.equal(median,v.median);
  assert.equal(v.candidate>median,v.afterMedian);assert.equal(v.candidate<=v.now+7200,v.notFuture);
  assert.equal(v.candidate>median&&v.candidate<=v.now+7200,v.valid);
 }
});
test('6060 headers preserve the original fixture and match raw-hash, MTP and exact retarget arithmetic',()=>{
 const meta=JSON.parse(read('bitcoin-timestamps.json'));
 const raw=Buffer.from(read('bitcoin-timestamps.hex').slice(2),'hex'),original=Buffer.from(read('bitcoin-798336.hex').slice(2),'hex');
 assert.equal(raw.length,6060*80);assert.deepEqual(raw.subarray(0,original.length),original);
 const refs=Buffer.from(read('bitcoin-timestamps-vectors.hex').slice(2),'hex');
 const history=Buffer.from(read('bitcoin-timestamps-ancestors.hex').slice(2),'hex');
 const cp=Buffer.from(meta.checkpointHeader,'hex');let previous=step(cp),bits=cp.readUInt32LE(72),epochTime=meta.epochStartTime,U=0;
 const times=[];for(let i=0;i<11;i++)times.push(history.readUInt32LE(i*80+68));times.push(previous.timestamp);
 const limit=0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
 const target=b=>{const exponent=b>>>24,mantissa=BigInt(b&0x7fffff);return exponent<=3?mantissa>>BigInt(8*(3-exponent)):mantissa<<BigInt(8*(exponent-3));};
 function compact(t){let size=0;for(let n=t;n>0n;n>>=8n)size++;let word=size<=3?t<<BigInt(8*(3-size)):t>>BigInt(8*(size-3));if(word&0x800000n){word>>=8n;size++;}return Number(word|BigInt(size)<<24n);}
 const retargets=[];
 for(let i=0;i<6060;i++){
  const h=raw.subarray(i*80,(i+1)*80),s=step(h),height=meta.start+i;
  assert.equal(h.subarray(4,36).toString('hex'),previous.internalHash);
  const median=times.slice(-11).sort((a,b)=>a-b)[5];assert.equal(meta.mtp[i],median);assert.ok(s.timestamp>median);
  if(height%2016===0){let t=target(bits)*BigInt(Math.max(302400,Math.min(4838400,previous.timestamp-epochTime)))/1209600n;if(t>limit)t=limit;bits=compact(t);epochTime=s.timestamp;retargets.push(height);}
  assert.equal(h.readUInt32LE(72),bits);assert.ok(BigInt('0x'+s.hash)<=target(bits));
  assert.equal(s.R,refs.subarray(i*32,(i+1)*32).toString('hex'));U+=s.delta;times.push(s.timestamp);previous=s;
 }
 assert.deepEqual(retargets,meta.retargets);assert.equal(U,meta.U);assert.equal((BigInt(U)*12000000000000n).toString(),meta.S_wad);
});
