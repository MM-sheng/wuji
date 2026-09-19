// WUJI keeper — keeps WujiIndex ticking (≤ every 256 blocks) and settles the vault when a series expires.
// Signs with `cast` (Foundry) so this file has no dependencies and never touches the key itself.
//
//   RPC=... PRIVATE_KEY=... CONTRACT=<WujiIndex> [VAULT=<WujiVault>] [INTERVAL=45] node indexer/keeper.mjs
//
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const { RPC, PRIVATE_KEY, CONTRACT, VAULT } = process.env;
const INTERVAL = +(process.env.INTERVAL || 45);
if (!RPC || !PRIVATE_KEY || !CONTRACT) { console.error('need RPC, PRIVATE_KEY, CONTRACT'); process.exit(1); }
const CAST = process.env.CAST || path.join(os.homedir(), '.foundry', 'bin', 'cast');
const cast = (...a) => execFileSync(CAST, [...a, '--rpc-url', RPC], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const send = (to, sig, gas, ...args) => cast('send', to, sig, ...args, '--private-key', PRIVATE_KEY, '--gas-limit', String(gas), '--json');
const num = s => Number(BigInt(s.split(' ')[0]));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function once() {
  const pending = num(cast('call', CONTRACT, 'pending()(uint256)'));
  if (pending >= 40) {                                     // tick when there is a meaningful backlog
    // blocks older than 256 are read through the EIP-2935 history contract (≈6k gas each) — budget for the worst case
    const n = Math.min(pending + 60, 1024);
    const r = JSON.parse(send(CONTRACT, 'tick(uint256)', 150_000 + n * 6_500, String(n)));
    log(`tick  pending=${pending} folded≤${n} status=${r.status} gas=${parseInt(r.gasUsed, 16)} ${r.transactionHash}`);
  }
  if (VAULT) {
    const id = num(cast('call', VAULT, 'currentId()(uint256)'));
    const expiry = num(cast('call', VAULT, 'series(uint256)(address,address,int256,uint64,uint64,bool,uint256)', String(id)).split('\n')[4]);
    if (Date.now() / 1000 >= expiry) {
      const r = JSON.parse(send(VAULT, 'settle()', 3_500_000));
      log(`settle series ${id} status=${r.status} ${r.transactionHash}`);
    }
  }
}
log(`keeper on ${CONTRACT}${VAULT ? ' + vault ' + VAULT : ''} every ${INTERVAL}s`);
for (;;) { try { await once(); } catch (e) { log('error:', (e.stderr || e.message || '').toString().split('\n')[0]); } await new Promise(r => setTimeout(r, INTERVAL * 1000)); }
