// Read-only reconciliation of the current header-only testnet from raw Bitcoin headers.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { step } from '../indexer/bitcoin.mjs';
import { rpcRequest } from '../indexer/evm-rpc.mjs';
import { sel } from '../indexer/zk-challenge.mjs';

const manifest = JSON.parse(fs.readFileSync('contracts/deployments/sepolia-header-v3.json'));
assert.equal(manifest.chainId, 11155111);
const rpc = (m, p) => rpcRequest(manifest.rpc, m, p);
assert.equal(BigInt(await rpc('eth_chainId', [])), 11155111n);
const block = await rpc('eth_getBlockByNumber', ['latest', false]);
const read = sig => rpc('eth_call', [{to: manifest.WujiHeaderIndex, data: sel(sig)}, block.number]);
const [heightHex, hash, sHex, conf, frozen] = await Promise.all(
  ['lastHeight()', 'lastHash()', 'S()', 'CONFIRMATIONS()', 'frozen()'].map(read));
const height = Number(BigInt(heightHex));
const raw = fs.readFileSync(process.env.HEADER_FILE || 'operator/sepolia-header-v3/headers/mainnet.bin');
assert.equal(raw.length % 80, 0);
assert.ok(raw.length >= (height + 101) * 80, 'local headers do not contain 100 descendants');
const header = h => raw.subarray(h * 80, (h + 1) * 80);
const anchor = JSON.parse(fs.readFileSync('contracts/deployments/sepolia-header-anchor.json'));
assert.equal(step(header(manifest.anchorHeight)).hash, anchor.anchorHash);
let prev = step(header(manifest.anchorHeight)).internalHash, u = 0n;
for (let h = manifest.genesisHeight; h <= height + 100; h++) {
  const bytes = header(h), s = step(bytes);
  assert.equal(bytes.subarray(4, 36).toString('hex'), prev, `broken link at ${h}`);
  if (h <= height) u += BigInt(s.delta);
  prev = s.internalHash;
}
const computedHash = '0x' + step(header(height)).internalHash;
const computedS = u * 12000000000000n;
const unsigned = BigInt(sHex), onchainS = unsigned >= (1n << 255n) ? unsigned - (1n << 256n) : unsigned;
assert.equal(computedHash, hash);
assert.equal(computedS, onchainS);
assert.equal(BigInt(conf), 100n);
assert.equal(BigInt(frozen), 0n);
const displayHash = step(header(height)).hash;
const sources = await Promise.all(['https://mempool.space/api', 'https://blockstream.info/api'].map(async base => {
  const response = await fetch(`${base}/block-height/${height}`, {signal: AbortSignal.timeout(20000)});
  assert.ok(response.ok, `Bitcoin source HTTP ${response.status}`);
  const sourceHash = (await response.text()).trim();
  assert.equal(sourceHash, displayHash);
  return {base, height, hash: sourceHash};
}));
assert.equal((await rpc('eth_getBlockByNumber', [block.number, false])).hash, block.hash, 'EVM snapshot changed');
const evidence = {observedAt: new Date().toISOString(), status:'matched', chainId:11155111,
  index:manifest.WujiHeaderIndex, evmBlock:block.number, evmBlockHash:block.hash,
  genesisHeight:manifest.genesisHeight, bitcoinHeight:height, rawHash:hash, displayHash,
  U:u.toString(), onchainS_wad:onchainS.toString(), recomputedS_wad:computedS.toString(),
  confirmations:100, descendantLinksChecked:100, sources,
  scope:'Raw local P2P headers replayed from the deployment anchor; final hash cross-checked with two HTTP sources. Not a third-party audit.'};
if (process.env.VERIFY_OUTPUT) fs.writeFileSync(process.env.VERIFY_OUTPUT, JSON.stringify(evidence, null, 2)+'\n');
console.log(JSON.stringify(evidence, null, 2));
