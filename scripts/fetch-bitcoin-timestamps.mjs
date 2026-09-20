// Extend the unchanged original fixture across three complete difficulty epochs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {BitcoinAPI,encodeHeader,step} from '../indexer/bitcoin.mjs';
const api=new BitcoinAPI(),dir='contracts/test/fixtures';
const old=JSON.parse(fs.readFileSync(dir+'/bitcoin.json'));
const first=798336,count=6060,raw=Buffer.from(fs.readFileSync(dir+'/bitcoin-798336.hex','utf8').slice(2),'hex');
const records=new Map();for(let i=0;i<raw.length/80;i++)records.set(first+i,raw.subarray(i*80,(i+1)*80));
const ends=[];for(let h=first+count-1;h>=first+old.count;h-=10)ends.push(h);
let cursor=0;
await Promise.all(Array.from({length:4},async()=>{
 while(cursor<ends.length){const blocks=await api.get('/blocks/'+ends[cursor++],true);
  for(const b of blocks)if(b.height>=first&&b.height<first+count)records.set(b.height,encodeHeader(b));
  if(cursor%40===0)console.log('extended headers',records.size);
 }
}));
const history=new Map();
for(const end of [first-2,first-12])for(const b of await api.get('/blocks/'+end,true))history.set(b.height,encodeHeader(b));
const ancestors=[];for(let h=first-12;h<first-1;h++)ancestors.push(history.get(h));
assert.ok(ancestors.every(Boolean));
const cp=Buffer.from(old.checkpointHeader,'hex');
let prev;
for(const h of [...ancestors,cp]){if(prev)assert.equal(h.subarray(4,36).toString('hex'),step(prev).internalHash);prev=h;}
const headers=[],mtp=[],vectors=[];let U=0;const times=[...ancestors,cp].map(h=>step(h).timestamp);
for(let i=0;i<count;i++){
 const h=records.get(first+i);assert.ok(h,'missing height '+(first+i));
 assert.equal(h.subarray(4,36).toString('hex'),step(prev).internalHash);
 const s=step(h),median=times.slice(-11).sort((a,b)=>a-b)[5];assert.ok(s.timestamp>median);
 mtp.push(median);times.push(s.timestamp);U+=s.delta;vectors.push(s.R);headers.push(h);prev=h;
}
fs.writeFileSync(dir+'/bitcoin-timestamps-ancestors.hex','0x'+Buffer.concat(ancestors).toString('hex'));
fs.writeFileSync(dir+'/bitcoin-timestamps.hex','0x'+Buffer.concat(headers).toString('hex'));
fs.writeFileSync(dir+'/bitcoin-timestamps-vectors.hex','0x'+vectors.join(''));
fs.writeFileSync(dir+'/bitcoin-timestamps.json',JSON.stringify({start:first,count,checkpointHeight:first-1,checkpointHeader:old.checkpointHeader,epochStartTime:old.epochStartTime,retargets:[798336,800352,802368,804384],lastTimestamp:times.at(-1),U,S_wad:(BigInt(U)*12000000000000n).toString(),mtp,source:api.urls},null,2)+'\n');
console.log('PASS',count,'headers; four retargets including the first fixture height');
