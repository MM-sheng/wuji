# Internal audit notes

Review date: 2026-09-19  
Scope: `WujiIndex.sol`, `WujiVault.sol`, `SeriesToken.sol`, deployment script, keeper assumptions  
Status: internal review only; not a substitute for an independent audit

Historical scope: these notes describe the earlier BSC-source implementation. They are not findings or
clearance for the Bitcoin-source Sepolia v4 release. Current review scope and evidence are collected in
[SEPOLIA_V4_HANDOFF.md](tasks/SEPOLIA_V4_HANDOFF.md); independent review is still pending.

## Findings

### WUJI-01 — High — Fixed, pending independent review — settlement-time optionality

`settle()` uses the index value immediately before the caller's transaction rather than a point fixed
before its hash is known. After expiry, a holder can wait for a favourable path before settling.
A prompt keeper narrows the opportunity but cannot remove it.

Fix: every boundary is derived from immutable `GENESIS_BLOCK` and `CHECKPOINT_INTERVAL` before its
hash exists. `WujiIndex` stores the exact S at each boundary, including deterministic zero-increment
checkpoints inside frozen gaps. `WujiVault.settle()` reads only that checkpoint even when called late.
Minting closes before the boundary block. Regression tests cover late settlement after a different
post-boundary path and checkpoint creation in normal and frozen-gap paths.

### WUJI-02 — Medium — Fixed — stale backlog could spill across series

Previously, `settle()` called the default `tick()` once. With more than 1024 pending blocks it froze a
stale `S`, opened the next series, and allowed remaining old blocks to move the new series.

Fix: settlement rejects a backlog above `DEFAULT_MAX`, folds the bounded remainder, and requires
`pending() == 0` before freezing the share. A regression test covers a 1100-block backlog.

### WUJI-03 — Medium — Fixed — fee-on-transfer collateral could underfund claims

Minting credited full pairs even if a non-standard token delivered less collateral than requested.

Fix: mint measures the vault balance delta and reverts unless it equals the required collateral.
A fee-on-transfer regression token confirms atomic rejection. Rebasing and adversarial ERC-20s remain
unsupported and must be excluded operationally.

### WUJI-04 — Medium — Fixed — unsafe production deployment defaults

The deployment script previously created `MockUSDT` when `ASSET` was missing and defaulted treasury to
the sender. A mistaken mainnet invocation could therefore deploy unusable production contracts.

Fix: deployments require an explicit expected chain id and treasury. Missing collateral is accepted
only when `ALLOW_MOCK_ASSET=true`; the testnet wrapper is the only script that sets this flag.

### WUJI-05 — Low — Fixed — `pending()` underflow before a future genesis

The constructor permits a future genesis, but `pending()` previously subtracted `lastBlock` from the
current height without guarding the pre-genesis case.

Fix: return zero at block zero and whenever the last configured block is not behind the chain.

### WUJI-06 — Informational — Accepted — block hashes are biasable

BNB block hashes are publicly verifiable and difficult to predict for ordinary users, but they are not
a cryptographic randomness beacon. Validator influence must be part of the public product claim and
risk disclosure.

### WUJI-07 — Informational — Accepted — pair arbitrage does not price each side

Minting and redeeming complete pairs constrains aggregate pair value. It does not guarantee the YANG or
YIN pool individually tracks the live claim value. The UI must distinguish contract claim value from
secondary-market execution price.

## Verification performed

- 36 Foundry tests pass: unit, 256-run fuzz cases, real BSC hashes, and 64 invariant runs / 3840 calls.
- Invariants cover solvency, matched open supply, whole-pair value, one open series, and fee destination.
- `forge fmt --check` and `forge build --sizes` pass.
- Runtime sizes remain below EVM limits; `WujiVault` is 17,326 bytes in the reviewed build.
- No tracked `.env` or private key was found.
- Slither/Mythril were unavailable in the local environment and remain checklist items.
