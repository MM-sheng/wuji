# T5 · Terminal heartbeat and IPFS

Branch: `codex/terminal-ipfs`. Baseline: `c74593a` (T4). Date: 2026-09-21.

## Delivered

- Bitcoin heartbeat: observed height/hash → mempool.space, header timestamp age (including future timestamps),
  folded height/backlog, mempool `timeAvg` with a labelled ten-minute fallback and no deterministic countdown.
  Series boundary and remaining contract-folded heights remain in 两仪 and the independent read panel.
- Steps preserves every cached price change as a vertical jump; Candles and Line remain. Default new sessions
  use Steps / 5m. Controls work at 390px and 1280px; no mobile body horizontal overflow after the control fix.
- Persisted indexer URL list, explicit source switching/reload, same-origin paper-account preservation and
  per-custom-source paper storage. Static IPFS opens source configuration even with no indexer available.
- Browser RPC reads at a fixed EVM block: exact signed S, indexer S/hash, share, series/token metadata,
  index/relay/asset/notional bindings. Chain and timestamp checks plus post-read hash recheck. Embedded public
  deployment registry covers BSC and Sepolia v3. Results have freshness limits and do not silently survive errors.
- Cached green cells are removed on source/RPC failure, even with an idle chart. Without a comparable indexer,
  RPC data displays as direct-only. Wallet writes require a fresh matching selected-vault snapshot;
  contracts, fees, permissions, pair math and existing financial invariant tests are unchanged.
- Bitcoin HTTP API now serves public read-only CORS and exact `yangShare_wad` / `notional_wad`. Tip height,
  hash and timestamp publish together, avoiding a new height briefly being paired with the preceding hash.
- `scripts/publish-ipfs.sh` stages **only index.html**, pins a CIDv1 directory and verifies the recursive pin
  and byte-for-byte readback. It does not publish repository files or signing credentials. Removed remote fonts.
  `docs/TERMINAL_IPFS.md` covers operation, trust boundaries and the future `wuji.market` DNSLink setup.

## Validation

- `forge test --root contracts`: **112 passed**, including original fuzz / financial invariants (64×60 runs/depth,
  fail-on-revert retained). No contract source or Solidity tests changed. `forge build --sizes` also passed.
- `node --test indexer/*.test.mjs scripts/*.test.mjs apps/terminal/*.test.mjs`: **74 passed**.
  Added checks cover 1-wei discrepancies, negative S, wrong RPC chain, stale snapshots, intra-read EVM reorg,
  altered bindings/hash/token/notional, direct-only results, old green DOM removal, TTL and vault changes,
  unverified wallet writes and source-tag spoofing, staircase segments, unsafe URLs, CORS/method restrictions, atomic tip publication,
  and IPFS scope/pin/readback failure handling. Existing financial and deployment tests were not weakened.
- Browser on :8793: Steps and 5m persisted; switching to `http://127.0.0.1:8793` successfully used CORS.
  A real matching observation was EVM **11750053**, Bitcoin **967914**, `S_wad=228000000000000`,
  `yangShare_wad=500114000000000000`. The displayed comparison explicitly refers to that snapshot.
- Deliberately selecting an unavailable local RPC immediately replaced the green badge with a failure.
  Restored the normal Sepolia RPC and `http://localhost:8793` source afterwards. No wallet transactions sent.
- Standalone page served from a local offline IPFS gateway: with no indexer configured, live Sepolia direct reads
  worked; after adding the localhost indexer, the chart and chain comparison were available cross-origin (EVM 11750080).
- Official Kubo **0.43.1** macOS arm64 archive was checked against its vendor SHA-512. Actual local recursive pin,
  `cat` byte comparison and repeated import CID equality succeeded. The repository is ignored local runtime data
  at `indexer/data/ipfs-terminal`; no peer identity/config or credentials are committed.

Final terminal directory CID:

```
bafybeigwx7t37y6je4hzzj4tnd47jpklcwyvgdu6bcosgswmsm45agz7xe
```

This identifies the HTML at delivery, not future edits. The offline gateway was a temporary acceptance service;
local pins remain. It does **not** establish public propagation or durable hosting. The existing :8793 indexer
was restarted to load the API fields/CORS; neither keeper nor BSC stacks were restarted.

## Remaining work

T6 is next. Public HTTPS indexer hosting, replicated/networked pinning and domain ownership/DNS are operational
prerequisites for a public site and are not configured here. T4's full live reconstruction from two independent
Bitcoin sources is still unproven after its earlier rate limits; browser RPC agreement does not satisfy that test.
RPC providers can lie or share infrastructure; selecting another URL alone does not prove independence.
Independent security review and the frozen single-sided exit issue (T9) remain open before mainnet.
