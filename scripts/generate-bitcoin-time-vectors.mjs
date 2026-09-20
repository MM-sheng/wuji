// Test fixture generator only. Uses the host C++ compiler, no runtime dependency for the protocol/indexer.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const commit='d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3'; // Bitcoin Core v30.0, peeled tag
const base=`https://raw.githubusercontent.com/bitcoin/bitcoin/${commit}/src/`;
async function source(name){const r=await fetch(base+name);assert.ok(r.ok);return r.text();}
const [chain,validation]=await Promise.all([source('chain.h'),source('validation.cpp')]);
assert.ok(chain.includes('MAX_FUTURE_BLOCK_TIME = 2 * 60 * 60'));
assert.ok(validation.includes('block.GetBlockTime() <= pindexPrev->GetMedianTimePast()'));
assert.ok(validation.includes('block.Time() > NodeClock::now() + std::chrono::seconds{MAX_FUTURE_BLOCK_TIME}'));
const begin=chain.indexOf('    int64_t GetMedianTimePast() const'),end=chain.indexOf('\n    }',begin)+6;
assert.ok(begin>0&&end>begin);const method=chain.slice(begin,end);
const cpp=`// Test harness; median method extracted verbatim from Bitcoin Core ${commit} src/chain.h.
// Copyright (c) 2009-2010 Satoshi Nakamoto; Copyright (c) 2009-2025 The Bitcoin Core developers.
// Distributed under the MIT software license: https://opensource.org/license/mit/
#include <algorithm>
#include <cstdint>
#include <iostream>
struct CBlockIndex {
 static constexpr int nMedianTimeSpan=11;
 const CBlockIndex* pprev=nullptr;
 int64_t time=0;
 int64_t GetBlockTime() const { return time; }
${method}
};
int main(){
 uint64_t now,candidate;
 while(std::cin>>now>>candidate){CBlockIndex nodes[11];
  for(int i=0;i<11;++i){std::cin>>nodes[i].time;if(i)nodes[i].pprev=&nodes[i-1];}
  auto median=nodes[10].GetMedianTimePast();
  // ContextualCheckBlockHeader predicates, with the supplied clock substituted for NodeClock::now().
  std::cout<<median<<' '<<(candidate>uint64_t(median))<<' '<<(candidate<=now+2*60*60)<<'\\n';
 }
}
`;
const vectors=[];
const windows=[Array(11).fill(1700000000),Array.from({length:11},(_,i)=>1700000000+i),Array.from({length:11},(_,i)=>1700000010-i),[0,0,0,0,0,0,0,0,0,0,0xffffffff],Array(11).fill(0xffffffff-100)];
let state=0x12345678;
for(let n=0;n<64;n++)windows.push(Array.from({length:11},()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return 1700000000+state%10000;}));
for(const times of windows){const median=[...times].sort((a,b)=>a-b)[5],now=Math.min(0xffffffff-7201,Math.max(...times)+1000);
 for(const candidate of [...new Set([Math.max(0,median-1),median,Math.min(0xffffffff,median+1),now+7200,now+7201])])vectors.push({times,now,candidate});
}
vectors.push({times:Array(11).fill(0xffffffff-100),now:0xffffffff-7200,candidate:0xffffffff});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wuji-core-time-'));
fs.writeFileSync(path.join(dir,'vectors.cpp'),cpp);
execFileSync(process.env.CXX||'c++',['-std=c++17','-O2',path.join(dir,'vectors.cpp'),'-o',path.join(dir,'vectors')]);
const input=vectors.map(v=>[v.now,v.candidate,...v.times].join(' ')).join('\n')+'\n';
const output=execFileSync(path.join(dir,'vectors'),{input,encoding:'utf8'}).trim().split('\n');assert.equal(output.length,vectors.length);
for(let i=0;i<vectors.length;i++){const [median,afterMedian,notFuture]=output[i].split(' ').map(Number);Object.assign(vectors[i],{median,afterMedian:!!afterMedian,notFuture:!!notFuture,valid:!!afterMedian&&!!notFuture});}
const sha=s=>createHash('sha256').update(s).digest('hex');
fs.writeFileSync('contracts/test/fixtures/core-timestamps.json',JSON.stringify({coreCommit:commit,coreTag:'v30.0',count:vectors.length,chainSha256:sha(chain),validationSha256:sha(validation),method:'Compiled the extracted CBlockIndex::GetMedianTimePast with the two ContextualCheckBlockHeader timestamp inequalities; not a full-node integration test.',vectors},null,2)+'\n');
console.log('PASS',vectors.length,'Core-derived timestamp vectors');
