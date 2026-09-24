// Keep a testnet stack alive and say so when it is not.
//
// The protocol does not need this: anyone may relay, fold and settle, and the contracts are indifferent
// to who does it. This exists because *observing* a stack for weeks does need it — on 2026-09-23 the
// keeper stalled for an hour behind two rate-limited APIs, and on 2026-09-24 one silent Bitcoin peer
// killed the indexer outright. Both were invisible until someone looked.
//
//   node scripts/watchdog.mjs --url http://localhost:8789 --start "./scripts/bitcoin-testnet.sh"
//
// Checks, every INTERVAL seconds:
//   * the indexer answers /head at all                      → restart if it does not
//   * the indexer is not stuck behind Bitcoin                → alert
//   * indexer S and contract S agree at the same height      → alert (this one is never normal)
//   * the keeper process exists and its log is advancing     → restart if the log is silent
//   * vault balance covers liabilities                       → alert (should be impossible)
//
// Alerts go to stdout and, if ALERT_COMMAND is set, to that command with the message on stdin.
// Restarts are rate limited; the watchdog never restarts more than MAX_RESTARTS times in an hour.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('url', process.env.WATCH_URL || 'http://localhost:8789');
const START = arg('start', process.env.WATCH_START || '');
const KEEPER_LOG = arg('keeper-log', process.env.WATCH_KEEPER_LOG || '/tmp/wuji-bsc-keeper.log');
const INTERVAL = +(arg('interval', process.env.WATCH_INTERVAL || 120));
const BEHIND_LIMIT = +(arg('behind', process.env.WATCH_BEHIND || 12));      // Bitcoin heights
const KEEPER_SILENCE = +(arg('keeper-silence', process.env.WATCH_KEEPER_SILENCE || 2400)); // seconds
const MAX_RESTARTS = +(process.env.WATCH_MAX_RESTARTS || 4);

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (...a) => console.log(stamp(), ...a);
const restarts = [];
let lastAlert = new Map();

function alert(key, message) {
  // Repeat an alert at most every 30 minutes so a long outage does not become a stream.
  const now = Date.now();
  if (now - (lastAlert.get(key) ?? 0) < 30 * 60_000) return;
  lastAlert.set(key, now);
  log('ALERT', message);
  const command = process.env.ALERT_COMMAND;
  if (!command) return;
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {});
  child.stdin.end(`WUJI watchdog: ${message}\n`);
}
const clear = key => lastAlert.delete(key);

async function head() {
  const response = await fetch(`${URL_BASE}/head`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`/head returned ${response.status}`);
  return response.json();
}

function restart(reason) {
  if (!START) { alert('restart', `${reason}; no --start configured, not restarting`); return; }
  const hour = Date.now() - 3600_000;
  while (restarts.length && restarts[0] < hour) restarts.shift();
  if (restarts.length >= MAX_RESTARTS) {
    alert('restart-limit', `${reason}; already restarted ${restarts.length} times this hour, giving up`);
    return;
  }
  restarts.push(Date.now());
  log('restarting:', reason);
  alert('restart', `restarting the stack: ${reason}`);
  execFile('/bin/sh', ['-c', START], { timeout: 120_000 }, (error, stdout, stderr) => {
    if (error) log('restart failed:', String(stderr || error.message).split('\n')[0]);
    else log('restart issued:', String(stdout).trim().split('\n').slice(-1)[0]);
  });
}

function keeperSilent() {
  try {
    const age = (Date.now() - fs.statSync(KEEPER_LOG).mtimeMs) / 1000;
    return age > KEEPER_SILENCE ? age : 0;
  } catch { return 0; } // no log yet: not evidence of failure
}

async function check() {
  let h;
  try {
    h = await head();
  } catch (error) {
    restart(`indexer unreachable (${error.message})`);
    return;
  }
  clear('down');

  const chain = h.chain ?? {};
  const behind = (h.chainHead ?? 0) - (h.height ?? 0);
  if (behind > BEHIND_LIMIT) alert('behind', `indexer ${behind} Bitcoin heights behind the tip`);
  else clear('behind');

  if (h.err) alert('source', `indexer source error: ${h.err}`);
  else clear('source');

  if (h.halted) alert('halted', 'indexer halted: finalized history changed (deep reorg)');
  else clear('halted');

  // The one that is never normal: the contract and the local recomputation disagree.
  if (chain.agree === false) {
    alert('divergence', `contract S ${chain.S_wad} != indexer S ${chain.indexer_S_wad} at height ${chain.lastHeight}`);
  } else clear('divergence');

  for (const vault of chain.vaults ?? []) {
    if (vault.balance !== undefined && vault.liabilities !== undefined && vault.balance + 1e-9 < vault.liabilities) {
      alert(`solvency-${vault.address}`, `${vault.symbol} vault balance ${vault.balance} < liabilities ${vault.liabilities}`);
    }
    const toSettle = (vault.settlementHeight ?? Infinity) - (h.chainHead ?? 0);
    if (toSettle < 0 && !vault.settled) {
      alert(`settle-${vault.address}`, `${vault.symbol} series ${vault.seriesId} is past its settlement height by ${-toSettle} blocks`);
    }
  }

  const silence = keeperSilent();
  if (silence) restart(`keeper log silent for ${Math.round(silence / 60)} minutes`);

  log(
    `height ${h.height} tip ${h.chainHead} behind ${behind}`,
    `contract ${chain.lastHeight ?? '-'} agree ${chain.agree ?? '-'}`,
    silence ? `keeper silent ${Math.round(silence / 60)}m` : 'keeper ok',
  );
}

log(`watching ${URL_BASE} every ${INTERVAL}s (behind>${BEHIND_LIMIT}, keeper silence>${KEEPER_SILENCE}s)`);
for (;;) {
  try { await check(); } catch (error) { log('check failed:', error.message); }
  await new Promise(resolve => setTimeout(resolve, INTERVAL * 1000));
}
