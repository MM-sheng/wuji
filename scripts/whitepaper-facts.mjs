// Offline audit trail for WHITEPAPER.md. Reads release constants and real-header fixtures; no RPC.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const json=p=>JSON.parse(read(p));
function constant(file,name){
 const value=read(file).match(new RegExp('\\bconstant\\s+'+name+'\\s*=\\s*([^;]+);'))?.[1].trim();
 assert.ok(value,'missing constant '+name);
 const compact=value.replaceAll('_','');
 if(/^\d+(?:\.\d+)?(?:e\d+)?$/i.test(compact))return Number(compact);
 const time=compact.match(/^(\d+) (hours|minutes|seconds)$/);assert.ok(time,'unsupported constant expression: '+value);
 return Number(time[1])*({hours:3600,minutes:60,seconds:1}[time[2]]);
}
const unitWad=constant('contracts/src/WujiIndex.sol','UNIT'),mean=constant('contracts/src/WujiIndex.sol','MEAN'),unit=unitWad/1e18;
const confirmations=constant('contracts/src/WujiIndex.sol','CONFIRMATIONS'),feeBps=constant('contracts/src/WujiVault.sol','FEE_BPS'),divisor=constant('contracts/src/RelayerRewards.sol','BOUNTY_DIVISOR');
const sepolia=json('contracts/deployments/sepolia-weth-v3.json'),bsc=json('contracts/deployments/bsc-testnet-timestamps-v3.json');
for(const m of [sepolia,bsc]){assert.equal(m.genesisHeight,sepolia.genesisHeight);assert.equal(m.checkpointInterval,sepolia.checkpointInterval);assert.equal(m.confirmations,confirmations);assert.equal(m.unitWad,String(unitWad));}
const varianceByteSum=32*(256**2-1)/12,sigma=unit*Math.sqrt(varianceByteSum);
const meta=json('contracts/test/fixtures/bitcoin.json'),bytes=Buffer.from(read('contracts/test/fixtures/bitcoin-798336.hex').trim().slice(2),'hex');
const header=bytes.subarray((800000-meta.start)*80,(800001-meta.start)*80);assert.equal(header.length,80);
const sha=b=>createHash('sha256').update(b).digest(),H=sha(sha(header)),R=sha(H),delta=[...R].reduce((a,b)=>a+b,0)-mean;
assert.equal(Buffer.from(H).reverse().toString('hex'),meta.known800000.hash);assert.equal(R.toString('hex'),meta.known800000.R);assert.equal(delta,meta.known800000.delta);
const bits=header.readUInt32LE(72),target=BigInt(bits&0x007fffff)<<(8n*BigInt((bits>>>24)-3));
// Exact total of each byte over all integers 0..target, under the stated uniform-valid-hash model.
function totalByteSum(max){const M=max+1n;let sum=0n;for(let j=0n;j<32n;j++){const b=256n**j,r=M%(256n*b),d=r/b;sum+=M/(256n*b)*b*32640n+b*d*(d-1n)/2n+d*(r%b);}return sum;}
const rawMean=Number(totalByteSum(target))/Number(target+1n);
const timestamps=json('contracts/test/fixtures/bitcoin-timestamps.json'),core=json('contracts/test/fixtures/core-timestamps.json');
const extendedBytes=(read('contracts/test/fixtures/bitcoin-timestamps.hex').trim().length-2)/2;
const assumedGasPerHeight=300000,assumedGwei=1,assumedHeightsPerDay=144,perHeight=assumedGasPerHeight*assumedGwei*1e-9;
assert.equal(extendedBytes/80,timestamps.count);
const out={
 basis:'Solidity constants, public v3 manifests, real Bitcoin fixtures; mathematical outputs are conditional models, not measured market returns',
 constants:{unitWad:String(unitWad),unit,mean,confirmations,feeBps,bountyDivisor:divisor,maxRelayAgeSeconds:constant('contracts/src/WujiIndex.sol','MAX_RELAY_AGE')},
 release:{genesisHeight:sepolia.genesisHeight,interval:sepolia.checkpointInterval,firstBoundary:sepolia.genesisHeight+sepolia.checkpointInterval-1,sepoliaNotionalWad:sepolia.vaults.WETH.notional},
 idealIndependentBytes:{varianceByteSum,standardDeviationByteSum:Math.sqrt(varianceByteSum),maximumAbsoluteStep:mean*unitWad/1e18,sigmaPerHeight:sigma,sigmaAt144Heights:sigma*Math.sqrt(144),meanDaysPerFullSeries:sepolia.checkpointInterval/assumedHeightsPerDay},
 known800000:{explorerHash:Buffer.from(H).reverse().toString('hex'),rawHash:H.toString('hex'),R:R.toString('hex'),delta,incrementWad:(BigInt(delta)*BigInt(unitWad)).toString(),nBits:'0x'+bits.toString(16),rawByteSumMeanUnderUniformValidHash:rawMean},
 scenarios:{assumedGasPerHeight,assumedGwei,assumedHeightsPerDay,costEthPerDay:perHeight*assumedHeightsPerDay,reserveEthForNextBounty:Number((perHeight*divisor).toFixed(8)),feeBaseEthPerDay:perHeight*assumedHeightsPerDay/(feeBps/10000),zeroRevenueHalfLifeDays:Math.log(.5)/Math.log(1-1/divisor)/assumedHeightsPerDay},
 evidence:{originalHeaders:bytes.length/80,extendedHeaders:extendedBytes/80,coreTimestampVectors:core.count,extendedRange:[timestamps.start,timestamps.start+timestamps.count-1],retargets:timestamps.retargets},
};
console.log(JSON.stringify(out,null,2));
