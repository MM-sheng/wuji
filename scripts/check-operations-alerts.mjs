// Read local monitoring state, summarize new transitions, and optionally acknowledge them.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
export function notification(report,cursor={},now=Date.now()){
 const checked=Date.parse(report?.checkedAt),measured=Date.parse(report?.metrics?.observedAt);
 const stale=!Number.isFinite(checked)||!Number.isFinite(measured)||now-checked>900000||now-measured>900000||checked-now>120000;
 if(stale)return {decision:cursor.stale?'DONT_NOTIFY':'NOTIFY',message:'WUJI 运营监控数据缺失或超过 15 分钟未更新，需要检查本机监控服务。',cursor:{...cursor,stale:true}};
 const old=cursor.seq||0,seq=report.seq;
 if(!Number.isSafeInteger(seq)||seq<old||!Array.isArray(report.events))return {decision:cursor.sequenceFault?'DONT_NOTIFY':'NOTIFY',message:'WUJI 运营告警序号异常，需要检查本地状态。',cursor:{...cursor,stale:true,sequenceFault:true}};
 const events=(report.events||[]).filter(e=>e.seq>old),latest=new Map(events.map(e=>[e.key,e]));
 const gap=seq>old&&(!events.length||events[0].seq>old+1);
 const messages=[...(cursor.stale?['运营监控已恢复。']:[]),...(gap?['告警历史存在缺口，请查看当前状态。']:[]),...[...latest.values()].map(e=>`${e.type==='recovered'?'恢复':e.severity==='critical'?'严重告警':'告警'}：${e.message}`)];
 if(gap)for(const item of Object.values(report.active||{}))messages.push(`当前异常：${item.message}`);
 return {decision:messages.length?'NOTIFY':'DONT_NOTIFY',message:messages.join('；')||'运营状态未发生新的可操作变化。',cursor:{seq,stale:false}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [reportFile,cursorFile]=process.argv.slice(2);if(!reportFile||!cursorFile)throw Error('usage: check-operations-alerts.mjs REPORT CURSOR [--ack]');
 let report,cursor={};try{report=JSON.parse(fs.readFileSync(reportFile));}catch{}
 if(fs.existsSync(cursorFile))cursor=JSON.parse(fs.readFileSync(cursorFile));
 const result=notification(report,cursor);
 if(process.argv.includes('--ack')){fs.writeFileSync(cursorFile+'.tmp',JSON.stringify(result.cursor,null,2)+'\n');fs.renameSync(cursorFile+'.tmp',cursorFile);}
 console.log(JSON.stringify({decision:result.decision,message:result.message}));
}
