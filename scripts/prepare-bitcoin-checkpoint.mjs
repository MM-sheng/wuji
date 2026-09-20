import fs from 'node:fs';
import {BitcoinAPI,encodeHeader,step} from '../indexer/bitcoin.mjs';
const a=new BitcoinAPI(['https://mempool.space/api']),b=new BitcoinAPI(['https://blockstream.info/api']);
const genesis=process.env.GENESIS_HEIGHT?Number(process.env.GENESIS_HEIGHT):Math.min(await a.tip(),await b.tip()),height=genesis-1;
if(!Number.isSafeInteger(genesis)||height<11)throw Error('checkpoint must have eleven ancestors');
const epochHeight=Math.floor(height/2016)*2016;
const blocks=new Map();
for(const end of [height,height-10,epochHeight]){
 const [one,two]=await Promise.all([a.get('/blocks/'+end,true),b.get('/blocks/'+end,true)]);
 const others=new Map(two.map(block=>[block.height,block]));
 for(const block of one){const other=others.get(block.height);if(!other)throw Error('checkpoint source height missing');
  const header=encodeHeader(block).toString('hex');if(header!==encodeHeader(other).toString('hex'))throw Error('checkpoint sources disagree');
  blocks.set(block.height,{header,hash:block.id});
 }
}
const cp=blocks.get(height),epoch=blocks.get(epochHeight);
if(!cp||!epoch)throw Error('checkpoint or epoch missing');
const raw=Buffer.from(cp.header,'hex'),bits=raw.readUInt32LE(72),size=bits>>>24,mantissa=BigInt(bits&0x7fffff);
const target=size<=3?mantissa>>BigInt(8*(3-size)):mantissa<<BigInt(8*(size-3));
const work=(1n<<256n)/(target+1n);
const history=Array.from({length:11},(_,i)=>{
 const ancestor=blocks.get(height-11+i);if(!ancestor)throw Error('checkpoint ancestor missing');return ancestor.header;
});
for(let i=1;i<12;i++)if((i===11?cp.header:history[i]).slice(8,72)!==step(history[i-1]).internalHash)throw Error('checkpoint ancestor linkage');
const record={genesisHeight:genesis,checkpointHeight:height,checkpointHeader:cp.header,checkpointHash:cp.hash,checkpointAncestors:history.join(''),epochStartHeight:epochHeight,epochStartTime:step(epoch.header).timestamp,checkpointChainWork:work.toString(),workConvention:'normalized to the checkpoint own work; common pre-checkpoint work is omitted for every branch',confirmations:6,checkpointInterval:4320,verifiedSources:[...a.urls,...b.urls]};
fs.mkdirSync('contracts/deployments',{recursive:true});fs.writeFileSync('contracts/deployments/bitcoin-checkpoint.json',JSON.stringify(record,null,2)+'\n');
fs.writeFileSync('contracts/deployments/bitcoin-checkpoint.env',`GENESIS_HEIGHT=${genesis}\nBTC_CHECKPOINT_HEIGHT=${height}\nBTC_CHECKPOINT_HEADER=0x${cp.header}\nBTC_CHECKPOINT_ANCESTORS=0x${record.checkpointAncestors}\nBTC_EPOCH_START_TIME=${record.epochStartTime}\nBTC_CHECKPOINT_WORK=${work}\nCHECKPOINT_INTERVAL=4320\n`);
console.log(JSON.stringify(record,null,2));
