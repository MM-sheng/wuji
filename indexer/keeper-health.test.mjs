import test from 'node:test';import assert from 'node:assert/strict';
import {keeperHealth,keeperCycle} from './keeper-health.mjs';
test('healthy index rounds cannot mask a failing pool; other pools still run',async()=>{
 const health=keeperHealth(3),calls=[];
 const cycle=()=>keeperCycle({round:async()=>({action:'wait',height:1,available:101}),
  maintainAccounts:async()=>{calls.push('all pools awaited');return [{pool:'A',transportFailed:true},{pool:'B',transportFailed:false}];},health,log:()=>{}});
 assert.equal(await cycle(),null);assert.equal(await cycle(),null);
 assert.match(await cycle(),/3 RPC maintenance failures.*A/);assert.equal(calls.length,3);
});
test('pool failures are independent and reset only when that pool recovers',()=>{
 const h=keeperHealth(2),record=(a,b)=>h.record(null,[{pool:'A',transportFailed:a},{pool:'B',transportFailed:b}]);
 assert.equal(record(true,false),null);assert.equal(record(false,true),null);assert.equal(record(true,false),null);
 assert.match(record(true,false),/for A/);
});
test('successful maintenance cannot reset index failure streaks',async()=>{
 const h=keeperHealth(2);let n=0;
 const cycle=()=>keeperCycle({round:async()=>{throw Error('network');},maintainAccounts:async()=>{n++;return [];},health:h,log:()=>{}});
 assert.equal(await cycle(),null);assert.match(await cycle(),/2 index rounds/);assert.equal(n,2);
});
test('semantic pool reverts do not trigger connection recovery; healthy round resets index errors',()=>{
 const h=keeperHealth(2);
 assert.equal(h.record(Error('offline'),[]),null);
 for(let i=0;i<5;i++)assert.equal(h.record(null,[{pool:'A',transportFailed:false}]),null);
 assert.equal(h.record(Error('offline'),[]),null);
});
test('restart threshold rejects invalid or disabled counters',()=>{
 for(const n of [0,-1,1.5,NaN,Infinity])assert.throws(()=>keeperHealth(n),/positive integer/);
});
