import test from 'node:test';import assert from 'node:assert/strict';import {notification} from './check-operations-alerts.mjs';
const now=Date.now(),fresh=()=>({checkedAt:new Date(now).toISOString(),metrics:{observedAt:new Date(now).toISOString()},seq:1,events:[{seq:1,key:'balance',type:'opened',severity:'warning',message:'low fuel'}]});
test('acknowledged transition stays quiet; new recovery notifies once',()=>{
 const r=fresh();let result=notification(r,{},now);assert.equal(result.decision,'NOTIFY');
 assert.equal(notification(r,result.cursor,now).decision,'DONT_NOTIFY');
 r.seq=2;r.events.push({seq:2,key:'balance',type:'recovered',message:'fuel recovered'});
 result=notification(r,result.cursor,now);assert.match(result.message,/恢复/);assert.equal(notification(r,result.cursor,now).decision,'DONT_NOTIFY');
});
test('missing/stale monitor alerts once and notifies its recovery',()=>{
 const missing=notification(undefined,{},now);assert.equal(missing.decision,'NOTIFY');assert.equal(notification(undefined,missing.cursor,now).decision,'DONT_NOTIFY');
 const r=fresh();assert.equal(notification(r,{seq:1,stale:true},now).decision,'NOTIFY');
 r.metrics.observedAt=new Date(now-1000000).toISOString();assert.equal(notification(r,{seq:1},now).decision,'NOTIFY');
});
test('truncated event history is visible, not silently acknowledged',()=>{
 const r=fresh();r.seq=100;r.events[0].seq=100;r.active={balance:{message:'low fuel'}};
 const result=notification(r,{seq:1},now);assert.equal(result.decision,'NOTIFY');assert.match(result.message,/历史存在缺口/);assert.match(result.message,/当前异常/);
});
test('persistent sequence corruption stays quiet after the first actionable alert',()=>{
 const r=fresh();r.seq=0;const first=notification(r,{seq:2},now);assert.equal(first.decision,'NOTIFY');assert.equal(notification(r,first.cursor,now).decision,'DONT_NOTIFY');
});
