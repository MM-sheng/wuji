// WUJI keeper — keeps WujiIndex ticking (≤ every 256 blocks) and settles fixed-block series.
// Signs with `cast` (Foundry) so this file has no dependencies and never touches the key itself.
//
//   RPC=... KEYSTORE_ACCOUNT=... PASSWORD_FILE=... CONTRACT=<WujiIndex> [FACTORY=<WujiVaultFactory>] [VAULT=<WujiVault>] [INTERVAL=45] node indexer/keeper.mjs
//   With FACTORY set, every vault the factory knows is settled; VAULT alone settles just that one.
//
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const { RPC, KEYSTORE_ACCOUNT, PASSWORD_FILE, CONTRACT, VAULT, FACTORY } = process.env;
const INTERVAL = +(process.env.INTERVAL || 45);
if (!RPC || !KEYSTORE_ACCOUNT || !PASSWORD_FILE || !CONTRACT) { console.error('need RPC, KEYSTORE_ACCOUNT, PASSWORD_FILE, CONTRACT (run contracts/scripts/set-key.sh)'); process.exit(1); }
const CAST = process.env.CAST || path.join(os.homedir(), '.foundry', 'bin', 'cast');
const RPC0 = RPC.split(',')[0];
const cast = (...a) => execFileSync(CAST, [...a, '--rpc-url', RPC0], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PWFILE = path.isAbsolute(PASSWORD_FILE) ? PASSWORD_FILE : path.join(process.cwd(), 'contracts', PASSWORD_FILE);
const send = (to, sig, gas, ...args) => cast('send', to, sig, ...args, '--account', KEYSTORE_ACCOUNT, '--password-file', PWFILE, '--gas-limit', String(gas), '--json');
const redact = s => { const lines = String(s).replace(/0x[0-9a-fA-F]{64}/g, '0x…').split('\n').map(l => l.trim()).filter(Boolean); return lines.find(l => /^Error|insufficient|revert|nonce|underpriced|timeout/i.test(l)) || lines.find(l => !/^Command failed/.test(l)) || 'cast send failed'; };
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
  const vaults = FACTORY ? listVaults() : VAULT ? [VAULT] : [];
  if (!vaults.length) return;
  const head = num(cast('block-number'));
  for (const v of vaults) {
    const id = num(cast('call', v, 'currentId()(uint256)'));
    const settlementBlock = num(cast('call', v, 'currentSettlementBlock()(uint64)'));
    if (head > settlementBlock) {
      const r = JSON.parse(send(v, 'settle()', 3_500_000));
      log(`settle ${v.slice(0, 10)} series ${id} at checkpoint #${settlementBlock} status=${r.status} ${r.transactionHash}`);
    }
  }
}
let vaultCache = { at: 0, list: [] };
function listVaults() {                                    // re-read the factory every ~10 min: anyone can add a vault
  if (Date.now() - vaultCache.at < 600_000) return vaultCache.list;
  const n = num(cast('call', FACTORY, 'count()(uint256)'));
  const list = []; for (let i = 0; i < n; i++) list.push(cast('call', FACTORY, 'vaults(uint256)(address)', String(i)));
  vaultCache = { at: Date.now(), list }; log(`factory has ${n} vault(s)`); return list;
}
log(`keeper on ${CONTRACT}${FACTORY ? ' + factory ' + FACTORY : VAULT ? ' + vault ' + VAULT : ''} every ${INTERVAL}s`);
for (;;) { try { await once(); } catch (e) { log('error:', redact([e.stderr, e.stdout, e.message].filter(Boolean).join('\n'))); } await new Promise(r => setTimeout(r, INTERVAL * 1000)); }
