#!/usr/bin/env bash
# Feed 200 REAL BSC block hashes (fetched from a public RPC) into WujiIndex via vm.setBlockhash
# and check the contract's S equals the indexer's ΔU · UNIT over the same range.
# (Public BSC nodes are not archive nodes, so a true state fork is unreliable; hashes are enough — they are the only input.)
set -euo pipefail
cd "$(dirname "$0")/.."
API=${API:-http://localhost:8787}
RPC=${BSC_RPC:-https://bsc-dataseed.binance.org}
HEAD=$(curl -s "$API/head" | python3 -c "import json,sys;print(json.load(sys.stdin)['block'])")
TO=$((HEAD-1)); FROM=$((TO-199))
node - "$RPC" "$API" "$FROM" "$TO" <<'JS'
const [rpc, api, frm, to] = [process.argv[2], process.argv[3], +process.argv[4], +process.argv[5]];
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async url => (await fetch(url)).json();
const hashes = new Map();
for (let a = frm; a <= to; a += 50) { // small batches; retry any block a lagging node returned as null
  const req = []; for (let b = a; b <= Math.min(to, a + 49); b++) req.push({ jsonrpc: '2.0', id: b, method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), false] });
  for (let tries = 0; tries < 5 && req.length; tries++) { const res = await post(rpc, req); for (const r of res) if (r.result) { hashes.set(r.id, r.result.hash); req.splice(req.findIndex(x => x.id === r.id), 1); } }
  if (req.length) throw new Error('could not fetch blocks ' + req.map(x => x.id));
}
const u = async b => (await get(`${api}/blocks?from=${b}&to=${b}`)).rows[0][2];
const du = (await u(to)) - (await u(frm - 1));
const out = { from: frm, to, hashes: [...Array(to - frm + 1)].map((_, i) => hashes.get(frm + i)), expectedSWad: (BigInt(du) * 330000000000n).toString() };
(await import('node:fs')).writeFileSync('test/fixtures/real-hashes.json', JSON.stringify(out));
console.log(`blocks #${frm}..#${to} · indexer ΔU=${du} · expected S_wad=${out.expectedSWad}`);
JS
forge test --mc WujiIndexRealHashes -vv
