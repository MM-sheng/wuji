# MTP timestamp-window correction

2026-10-12. Source base: `d443528d3ece8000ca03735c6ec1ce94186f2e70`. Fixed in the local
`codex/fix-mtp-window` branch; no deployment, pool migration or public disclosure performed by this task.

## Defect and scope

`WujiHeaderIndex._median` and `ZkWujiIndex._median` previously used
`uint32[11] memory t = input`. Solidity memory-to-memory assignment aliases an array, so insertion sort
changed the caller's chronological window. The subsequent left shift removed the smallest timestamp
instead of the oldest block. The next MTP could therefore be wrong.

For timestamps offset by a constant, `[11,1,2,3,4,5,6,7,8,9,10]` is a possible chronological window.
After a block stamped 12, the correct window is `[1,2,3,4,5,6,7,8,9,10,12]`, with median 6. A next block
stamped 7 is valid under MTP. The old replay rejects it. Synthetic tests only lower the PoW target through
the existing test subclass; the production validation and window logic remain unchanged. A separate
test uses real Bitcoin headers and the unmodified production PoW checks.

Both helpers now explicitly copy the eleven items into a fresh memory array before sorting. This fixes
header folding and reorg replay, and the other callers of the shared ZK replay helper. The older
`BitcoinRelay` builds a disposable local array for its median and does not reuse it as a rolling window;
it does not need this change. Rust fixed arrays already copy by value; its code is unchanged.

No change to S, PoW, retarget rules, confirmation depth, freeze threshold, rewards or account settlement.
The issue is a validation/liveness defect; this report does not establish fund theft or a currently stuck
deployment. Independent review remains necessary.

## Regression evidence

Before the source fix, the added tests produced five failures and two passes:

- Both implementations rejected the valid backward-time header.
- Both implementations rejected the valid reorg replay.
- The real-header window check diverged from canonical timestamps.
- Both implementations still rejected a timestamp equal to the correct median (a boundary control).

After the fix all seven pass. The backward-time cases also extend in a second transaction and check
every timestamp slot. The real-header case checks both production implementations against the original
Bitcoin header bytes over 1,000 folded heights, rather than relying on agreement between implementations
that previously shared the defect.

`FullHistoryReplay.t.sol` now checks all eleven timestamps after every batch, against the source header
sequence. The existing cached dataset covers heights 11 through 969,692, with 100 confirmations and
24 independent anchors. All 24 segments pass, including unchanged final S, work and tip hashes. The
dataset was reused from the earlier replay, not downloaded from fresh nodes during this task.

## Verification

Toolchain: Foundry 1.8.4, solc 0.8.28, optimizer 200, Prague, non-via-IR. The repository CI pins Foundry
1.8.3; that hosted CI was not run in this local-only task.

| Check | Result |
|---|---|
| Solidity suites excluding separately run full history | 260 passed, 0 failed, 0 skipped |
| Full historical replay with canonical-window assertions | 24 passed, 0 failed, 0 skipped |
| Node indexer/scripts/terminal tests | 180 passed, 0 failed, 1 skipped |
| Rust header-core release tests | 7 passed |
| Local production-keeper seal and pool-exit drill | Passed; all three account payouts reconciled |
| Contract sizes | HeaderIndex 10,188 bytes; ZkWujiIndex 22,074 bytes; both below EIP-170 |

Commands, from the repository root:

```sh
forge test --root contracts --no-match-contract FullHistoryReplay -j 4
WUJI_REPLAY_DIR=cache/replay forge test --root contracts --match-contract FullHistoryReplay --gas-limit 18446744073709551615 -j 4
node --test indexer/*.test.mjs scripts/*.test.mjs apps/terminal/*.test.mjs
cargo test --release --manifest-path zk/wuji-header-core/Cargo.toml
forge build --root contracts --sizes
node scripts/seal-drill.mjs
```

The full-history command needs the separately generated `contracts/cache/replay` fixture. Its assertions
are enabled whenever that replay runs; normal CI still skips the historical suite without that dataset.

## Gas impact

Copying the window adds per-header execution work. Measurements after the fix:

- The existing real-header `test_gas`: 7,049,725 gas for the measured `foldHeaders` call with 350 headers,
  K=100, 250 folded heights. This test measures execution with `gasleft`, not full transaction cost.
- End-to-end seal drill: a 284-header seal used 4,898,073 transaction gas, versus the historical
  4.33M figure. The exact comparison depends on the generated timestamps and calldata.
- An additional local transaction accepted 800 reorg headers at K=100 for 13,973,172 gas, below
  16,777,216. It uses regtest PoW and chronological timestamps; it is not a universal worst-case bound
  for every retarget and timestamp ordering. Keep the release checklist's target-chain gas check open.

No cap or keeper limit was raised to accommodate the fix.

## Existing Sepolia deployment

Observed 2026-10-12 07:00:29 Asia/Shanghai (2026-10-11T23:00:29.757Z), at Sepolia block 11,894,867,
hash `0xdd8f5df34182e1fb78a7e55c172038dc8e74dd131bdb16bd6e09b5c5b30f9b5e`:

- Address: `0x2d61Dd88F9c0F8069fFd3DaaeD76B4aE404AB9f7`.
- Runtime size: 10,104 bytes, matching the old implementation.
- Comparison included compiler metadata; only 15 compiler-declared immutable slots were masked.
- Actual runtime SHA-256: `620e838af390c0f491bfbaeb34f7adb237330712cbde9717164a960a755cbe1a`.
- Masked runtime SHA-256: `3e3149c05ae695f2efdd85c4c0ecb4526058133c12d569033dc15031c8011647`.
- The observation block hash was rechecked after reads.

Raw result: [bytecode check](2026-10-12-mtp-bytecode.json). This verifies the old implementation is deployed;
it does not independently validate every immutable value, account balance or historical ZK deployment.

## Remaining deployment work

1. Independently review the corrected source, replay results and gas margins.
2. Build a fresh testnet deployment with reviewed anchor/header ancestry, genesis, rewards bindings and
   compiler settings. Verify bytecode and each immutable value, then replay and independently compare S,
   tip hash, work and chronological timestamp windows.
3. Decide whether the fresh index preserves the existing index origin. A fresh anchor with U=0 creates a
   different S path; equal Bitcoin rules alone do not preserve the old numerical index or account claims.
4. Existing pools bind their index immutably. They cannot be redirected to a new index by fixing the
   source or restarting the keeper. New pools need their own deployment and an explicit user exit/re-entry
   plan. Existing claims and old addresses must remain identifiable.
5. Record the new deployment and update clients/keepers only after verification. Keep old deployments
   labelled as historical/affected. The separate pool bad-debt design and independent audit gate remain open.

At the time of this source-fix report, no funds were moved, no old service was stopped, and no corrected
address had been deployed. The user's subsequent redeployment request is completed separately in the
[Sepolia v2 deployment report](2026-10-12-sepolia-header-v2.md). Old account claims remain in the old pools.
