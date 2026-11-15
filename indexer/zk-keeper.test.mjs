import test from 'node:test'; import assert from 'node:assert/strict';
process.env.RPC ||= 'http://127.0.0.1:1'; process.env.CHAIN_ID ||= '31337';
process.env.ZK_INDEX ||= '0x' + '11'.repeat(20); process.env.ZK_UNLOCKED_FROM ||= '0x' + '22'.repeat(20);
// The keeper saves finalized states for sealing (seal.mjs); keep them out of indexer/data.
process.env.ZK_WORK_DIR ||= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'wuji-keeper-test-'));
const { decodeContinuity } = await import('./zk-keeper.mjs');
const w = n => (BigInt.asUintN(256, BigInt(n))).toString(16).padStart(64, '0');
test('continuity() decodes into the host input shape, including a negative U', () => {
  const hash = 'ab'.repeat(32);
  const hex = '0x' + hash + w(798429) + w(0x17053894) + w(1700000000) + w(1699000000) + w(-2017)
    + Array.from({ length: 11 }, (_, i) => w(1699999000 + i)).join('') + w(123456789n);
  const c = decodeContinuity(hex);
  assert.equal(c.hash, '0x' + hash); assert.equal(c.height, 798429); assert.equal(c.bits, 0x17053894);
  assert.equal(c.u, '-2017'); assert.equal(c.recentTimes.length, 11); assert.equal(c.recentTimes[10], 1699999010);
  assert.equal(BigInt(c.work), 123456789n);
  assert.throws(() => decodeContinuity('0x1234'));
});

test('real account-maintenance path reports transport failures for every pool',async()=>{
 const {maintainAccounts}=await import('./zk-keeper.mjs');const original=globalThis.fetch;
 globalThis.fetch=async()=>{throw Object.assign(Error('not logged'),{code:'ECONNRESET'});};
 try{
  const pools=['0x'+'33'.repeat(20),'0x'+'44'.repeat(20)];
  const results=await maintainAccounts({},pools);
  assert.deepEqual(results,pools.map(pool=>({pool,transportFailed:true})));
 }finally{globalThis.fetch=original;}
});

test('index capability reads propagate network failure rather than caching a default',async()=>{
 const {round}=await import('./zk-keeper.mjs?optional-rpc');const {sel}=await import('./zk-challenge.mjs');
 const original=globalThis.fetch;let sourceAccessed=false;
 globalThis.fetch=async(_url,init)=>{
  const {method,params,id}=JSON.parse(init.body);
  if(method==='eth_call'&&params[0].data===sel('MAX_PROOF_HEADERS()'))throw Object.assign(Error('offline'),{code:'ECONNRESET'});
  return new Response(JSON.stringify({jsonrpc:'2.0',id,result:method==='eth_chainId'?'0x7a69':'0x'+'0'.repeat(64)}));
 };
 try{
  await assert.rejects(round({tip:async()=>{sourceAccessed=true;return 1;}}),e=>e.rpcTransportError&&/ECONNRESET/.test(e.message));
  assert.equal(sourceAccessed,false);
 }finally{globalThis.fetch=original;}
});

test('a Bitcoin source that never answers fails the round instead of hanging the keeper', async () => {
  process.env.ZK_SOURCE_TIMEOUT_S = '0.2';
  const { round } = await import('./zk-keeper.mjs?timeout');
  const rpcStub = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    const result = method === 'eth_chainId' ? '0x7a69' : '0x' + '0'.repeat(1152);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  try {
    const hanging = { tip: () => new Promise(() => {}), at: () => new Promise(() => {}) };
    await assert.rejects(round(hanging), /timed out/);
  } finally { globalThis.fetch = rpcStub; }
});

test('the keeper does not prove on top of a pending batch that does not match the chain', async () => {
  const { encodeBatch, encodeContinuity, fixture, header, journal, w } = await import('./zk-test-helpers.mjs');
  const { sel } = await import('./zk-challenge.mjs');
  const { step } = await import('./bitcoin.mjs');
  const j = journal(fixture('zk-journal.hex'));
  // A forgery that keeps the real end hash but claims a different U: it still links, so only replay catches it.
  const batch = { to: { ...j.to, u: String(BigInt(j.to.u) + 7n) }, checkpointHeights: [], checkpointU: [],
    prover: '0x' + '11'.repeat(20), finalAt: 1000, disputer: '0x' + '0'.repeat(40), respondBy: 0, backed: false };
  const views = {
    [sel('GENESIS_HEIGHT()')]: w(j.genesisHeight), [sel('CHECKPOINT_INTERVAL()')]: w(4320), [sel('CONFIRMATIONS()')]: w(6),
    [sel('MAX_HEADERS()')]: w(512), [sel('MAX_PROOF_HEADERS()')]: w(250), [sel('pendingCount()')]: w(1),
    [sel('finalize(uint256)')]: w(0), [sel('firstPending()')]: w(0), [sel('nextBatch()')]: w(1),
    [sel('DISPUTE_BOND()')]: w(1), [sel('verifier()')]: w(0x5f1), // a proof-path index
  };
  const rpcStub = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    let result;
    if (method === 'eth_chainId') result = '0x7a69';
    else if (method === 'eth_getBlockByNumber') result = { timestamp: '0x1f4' };
    else {
      const data = params[0].data, s = data.slice(0, 10);
      if (s === sel('batch(uint256)')) result = encodeBatch(batch);
      else if (s === sel('stateBefore(uint256)')) result = encodeContinuity(j.prev);
      else if (s === sel('continuity()')) result = encodeContinuity(batch.to);
      else result = '0x' + views[s];
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  try {
    const { round } = await import('./zk-keeper.mjs?guard');
    const source = { tip: async () => j.prev.height + 6060, at: async h => { const x = header(h - j.prev.height - 1); return { header: x, hash: step(x).hash }; } };
    const r = await round(source);
    assert.equal(r.action, 'blocked');
  } finally { globalThis.fetch = rpcStub; }
});

test('keeper clamps fold size to on-chain RelayerRewards.MAX_HEIGHTS when reward tokens are set', async () => {
  const { encodeContinuity, fixture, header, journal, w } = await import('./zk-test-helpers.mjs');
  const { sel } = await import('./zk-challenge.mjs');
  const { step } = await import('./bitcoin.mjs');
  const j = journal(fixture('zk-journal.hex'));
  const rewardsAddr = '0x' + 'aa'.repeat(20);
  const oldFold = process.env.ZK_MAX_FOLD, oldTok = process.env.ZK_REWARD_TOKENS, oldWork = process.env.ZK_WORK_DIR;
  process.env.ZK_MAX_FOLD = '80';
  process.env.ZK_REWARD_TOKENS = '0x' + 'bb'.repeat(20);
  process.env.ZK_WORK_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'wuji-keeper-cap-'));
  const views = {
    [sel('rewards()')]: w(BigInt(rewardsAddr)),
    [sel('GENESIS_HEIGHT()')]: w(j.genesisHeight), [sel('CHECKPOINT_INTERVAL()')]: w(4320), [sel('CONFIRMATIONS()')]: w(6),
    [sel('MAX_HEADERS()')]: w(512), [sel('MAX_PROOF_HEADERS()')]: w(0), [sel('verifier()')]: w(0),
    [sel('DISPUTE_BOND()')]: w(0), [sel('REORG_MARGIN()')]: w(144), [sel('MAX_REORG_HEADERS()')]: w(800),
    [sel('MAX_REORG_SEGMENT_HEADERS()')]: w(0), [sel('frozen()')]: w(0), [sel('pendingCount()')]: w(0),
  };
  const h0 = header(0), s0 = step(h0);
  const startCont = { ...j.prev, height: j.prev.height + 1, hash: '0x' + s0.internalHash };
  let maxRequestedHeight = 0;
  const rpcStub = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    let result;
    if (method === 'eth_chainId') result = '0x7a69';
    else {
      const to = (params[0].to || '').toLowerCase(), s = params[0].data.slice(0, 10);
      if (to === rewardsAddr && s === sel('MAX_HEIGHTS()')) result = '0x' + w(40); // on-chain cap < ZK_MAX_FOLD (80)
      else if (to === rewardsAddr && s === sel('claimable(address,address)')) result = '0x' + w(0);
      else if (s === sel('continuity()')) result = encodeContinuity(startCont);
      else result = '0x' + views[s];
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  try {
    const { round } = await import('./zk-keeper.mjs?reward-cap');
    // Let all 46 headers (6 confirmations + 40 on-chain MAX_HEIGHTS) succeed; fail if header 47..86 is requested.
    const source = {
      tip: async () => startCont.height + 90,
      at: async h => {
        if (h === startCont.height) return { height: h, header: h0, hash: s0.hash };
        const idx = h - startCont.height;
        maxRequestedHeight = Math.max(maxRequestedHeight, idx);
        if (idx > 46) throw Error(`exceeded-reward-cap:${idx}`);
        const x = header(idx);
        return { height: h, header: x, hash: step(x).hash };
      },
    };
    await assert.rejects(round(source), e => {
      if (/exceeded-reward-cap/.test(e.message)) return false;
      return true;
    });
    assert.equal(maxRequestedHeight, 46);
  } finally {
    globalThis.fetch = rpcStub;
    if (oldFold === undefined) delete process.env.ZK_MAX_FOLD; else process.env.ZK_MAX_FOLD = oldFold;
    if (oldTok === undefined) delete process.env.ZK_REWARD_TOKENS; else process.env.ZK_REWARD_TOKENS = oldTok;
    if (oldWork === undefined) delete process.env.ZK_WORK_DIR; else process.env.ZK_WORK_DIR = oldWork;
  }
});

test('frozen proof-mode keeper drains a full 32-batch queue in 16-batch chunks with simulation and safe gas', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fixture, journal, w } = await import('./zk-test-helpers.mjs');
  const { sel } = await import('./zk-challenge.mjs');
  const j = journal(fixture('zk-journal.hex'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wuji-keeper-frozen32-'));
  const logFile = path.join(tmp, 'cast-calls.jsonl');
  const stateFile = path.join(tmp, 'pending.txt');
  const mockCast = path.join(tmp, 'mock-cast');
  fs.writeFileSync(stateFile, '32');
  fs.writeFileSync(mockCast, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
if (args[0] === 'call') {
  process.stdout.write((args[2].startsWith('cancelFrozen') ? args[3] : '50000000000000000') + '\\n');
} else if (args[0] === 'send') {
  if (args[2] === 'cancelFrozen(uint256)') {
    const cur = Number(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
    fs.writeFileSync(${JSON.stringify(stateFile)}, String(Math.max(0, cur - Number(args[3]))));
  }
  process.stdout.write(JSON.stringify({ status: '0x1', transactionHash: '0x' + 'cc'.repeat(32), gasUsed: '0x118c30' }));
}
`);
  fs.chmodSync(mockCast, 0o755);

  const oldCast = process.env.CAST, oldWork = process.env.ZK_WORK_DIR;
  process.env.CAST = mockCast;
  process.env.ZK_WORK_DIR = tmp;

  const views = {
    [sel('GENESIS_HEIGHT()')]: w(j.genesisHeight), [sel('CHECKPOINT_INTERVAL()')]: w(4320), [sel('CONFIRMATIONS()')]: w(6),
    [sel('MAX_HEADERS()')]: w(512), [sel('MAX_PROOF_HEADERS()')]: w(250), [sel('verifier()')]: w(0x5f1),
    [sel('DISPUTE_BOND()')]: w(5n * 10n ** 16n), [sel('REORG_MARGIN()')]: w(144), [sel('MAX_REORG_HEADERS()')]: w(800),
    [sel('MAX_REORG_SEGMENT_HEADERS()')]: w(256), [sel('frozen()')]: w(1),
    [sel('owed(address)')]: w(5n * 10n ** 16n),
  };
  const rpcStub = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    let result;
    if (method === 'eth_chainId') result = '0x7a69';
    else {
      const s = params[0].data.slice(0, 10);
      if (s === sel('pendingCount()')) result = '0x' + w(Number(fs.readFileSync(stateFile, 'utf8')));
      else result = '0x' + views[s];
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };

  try {
    const { round, CANCEL_FROZEN_BATCH, cancelFrozenGas } = await import('./zk-keeper.mjs?frozen-full-32');
    assert.equal(CANCEL_FROZEN_BATCH, 16);
    assert.equal(cancelFrozenGas(16), 4_500_000);
    assert.equal(cancelFrozenGas(32), 8_500_000);

    const r = await round({ tip: async () => 0, at: async () => { throw Error('unused'); } });
    assert.equal(r.action, 'frozen');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '0');

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls.length, 6, '2x (simulate + send cancelFrozen(16)) + 1x (simulate + send withdraw)');
    assert.deepEqual(calls.map(c => [c[0], c[2], c[3]]), [
      ['call', 'cancelFrozen(uint256)(uint256)', '16'],
      ['send', 'cancelFrozen(uint256)', '16'],
      ['call', 'cancelFrozen(uint256)(uint256)', '16'],
      ['send', 'cancelFrozen(uint256)', '16'],
      ['call', 'withdraw()(uint256)', '--rpc-url'],
      ['send', 'withdraw()', '--rpc-url'],
    ]);
    for (const sendCall of [calls[1], calls[3]]) {
      const gasIdx = sendCall.indexOf('--gas-limit');
      assert.equal(sendCall[gasIdx + 1], '4500000', '16-batch cancelFrozen uses 4.5M gas (>1.5M spare above worst-case pre-refund)');
    }
  } finally {
    globalThis.fetch = rpcStub;
    if (oldCast === undefined) delete process.env.CAST; else process.env.CAST = oldCast;
    if (oldWork === undefined) delete process.env.ZK_WORK_DIR; else process.env.ZK_WORK_DIR = oldWork;
  }
});
