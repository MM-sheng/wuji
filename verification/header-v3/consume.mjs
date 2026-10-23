// Example consumer: verified historical data only. No transaction or wallet path.
import assert from 'node:assert/strict';
import { verifyArchive } from './verify.mjs';
assert.equal(process.argv.length,3,'Usage: node consume.mjs ARCHIVE_DIRECTORY');
const result=verifyArchive(process.argv[2]);
const state=result.bitcoin.finalized;
console.log(JSON.stringify({kind:'WUJI_HISTORICAL_SAMPLE',chainId:result.chainId,index:result.index,
  evmBlockHash:result.evmBlock.hash,bitcoinHeight:state.height,bitcoinRawHash:state.hash,
  S_wad:state.S_wad,displayIndex:100*Math.exp(Number(state.S_wad)/1e18),
  displayOnly:true,tradableQuote:false,live:false},null,2));
