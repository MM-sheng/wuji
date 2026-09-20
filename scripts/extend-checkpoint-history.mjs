// Preserve the previously compared checkpoint/genesis; authenticate newly fetched ancestors by its committed parent hash.
import fs from 'node:fs';import assert from 'node:assert/strict';
import {BitcoinAPI,encodeHeader,step} from '../indexer/bitcoin.mjs';
const file='contracts/deployments/bitcoin-checkpoint.json',j=JSON.parse(fs.readFileSync(file));
assert.equal(step(j.checkpointHeader).hash,j.checkpointHash);
assert.equal(j.genesisHeight,j.checkpointHeight+1);
const api=new BitcoinAPI(['https://mempool.space/api']),blocks=new Map();
for(const end of [j.checkpointHeight-1,j.checkpointHeight-11])for(const b of await api.get('/blocks/'+end,true))blocks.set(b.height,encodeHeader(b).toString('hex'));
const history=Array.from({length:11},(_,i)=>blocks.get(j.checkpointHeight-11+i));assert.ok(history.every(Boolean));
for(let i=1;i<12;i++)assert.equal((i===11?j.checkpointHeader:history[i]).slice(8,72),step(history[i-1]).internalHash);
j.checkpointAncestors=history.join('');j.historySource=api.urls[0];
j.historyVerification='Eleven linked raw headers authenticated by the unchanged, previously compared checkpoint parent hash. verifiedSources refers to the existing checkpoint and epoch, not a new two-source download of every ancestor.';
fs.writeFileSync(file,JSON.stringify(j,null,2)+'\n');
const envFile='contracts/deployments/bitcoin-checkpoint.env',env=fs.readFileSync(envFile,'utf8').replace(/^BTC_CHECKPOINT_ANCESTORS=.*\n?/m,'');
fs.writeFileSync(envFile,env.trimEnd()+`\nBTC_CHECKPOINT_ANCESTORS=0x${j.checkpointAncestors}\n`);
console.log('PASS unchanged checkpoint',j.checkpointHeight,'authenticated ancestors',history.length);
