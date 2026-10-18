// Read-only validation of full-history fixtures against the current P2P archive.
// Recomputes reference sums without regenerating or replacing any fixture.
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const {step}=await import('../indexer/bitcoin.mjs');const {targetOf,workOf}=await import('../indexer/zk-challenge.mjs');
const dir='contracts/cache/replay',raw=fs.readFileSync('operator/sepolia-header-v3/headers/mainnet.bin');const pieces=Array.from({length:24},(_,i)=>({i,j:JSON.parse(fs.readFileSync(`${dir}/seg-${i}.json`))}));assert.equal(pieces[0].j.anchorHeight,10);const end=pieces.at(-1).j.endHeight;assert.ok(raw.length>=(end+101)*80);
const prefix=raw.subarray(0,(end+101)*80);const u=[0n],work=[0n];let prev;let genesis;
for(let h=0;h<=end+100;h++){
 const bytes=prefix.subarray(h*80,(h+1)*80),s=step(bytes),target=targetOf(bytes.readUInt32LE(72));
 if(h===0){assert.equal(s.hash,'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');genesis=s.hash;}
 else assert.equal(bytes.subarray(4,36).toString('hex'),prev,`link ${h}`);
 assert.ok(BigInt('0x'+s.hash)<=target,`PoW ${h}`);prev=s.internalHash;u.push(u.at(-1)+BigInt(s.delta));work.push(work.at(-1)+workOf(target));
}
const results=[];for(const {i,j} of pieces){const a=j.anchorHeight,e=j.endHeight;assert.ok(i===0||a===pieces[i-1].j.endHeight);const bin=fs.readFileSync(`${dir}/seg-${i}.bin`);assert.ok(bin.equals(prefix.subarray(a*80,(e+101)*80)));assert.equal(u[e+1]-u[a+1],BigInt(j.expectedU));assert.equal(work[e+1]-work[a+1],BigInt(j.expectedWork));assert.equal('0x'+step(prefix.subarray(e*80,(e+1)*80)).internalHash,j.endHash);assert.deepEqual(j.ancestorTimes,Array.from({length:11},(_,k)=>prefix.readUInt32LE((a-10+k)*80+68)));results.push({segment:i,anchorHeight:a,endHeight:e,expectedU:String(j.expectedU),binSha256:createHash('sha256').update(bin).digest('hex')});}
const out={checkedAt:new Date().toISOString(),status:'PASS',genesis,rawPrefixSha256:createHash('sha256').update(prefix).digest('hex'),sourcePrefixLastHeight:end+100,fromHeight:11,toHeight:end,segments:results,scope:'Cached segment bytes exactly match current raw P2P archive prefix. All prefix links and PoW checked from genesis; per-segment U, work and ancestor timestamps independently recomputed. Solidity segment replay separately checks consensus/retarget/MTP.'};fs.writeFileSync('contracts/deployments/t13-full-history-data-2026-10-18.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({status:out.status,from:11,to:end,segments:results.length}));
