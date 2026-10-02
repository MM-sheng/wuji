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

### WUJI-08 — Medium — Fixed in source, deployed contract affected — forged proofs could hold the ZK index (T12)

Found 2026-10-01 reviewing T12 after its Sepolia deployment (`0x0ee930Fe…6B47`). Assumes a broken proof
system (the case T12 exists for). New proofs must extend the head of the pending queue, and `foldHeaders`
is closed while anything is pending. An attacker who keeps one forged batch at the head (re-proposing on
the finalized state each time the previous one is rejected, one proof per `W + R`) blocks every honest
proof and the header path: the index cannot be corrupted (watchers dispute) but cannot advance either,
breaking the T10 property that liveness never depends on the proof system.

Fix: `refute(id, headers, tokens)`. For a disputed, unbacked batch, the real headers over its range,
replayed from its starting state, must reach a different end state; the batch and its successors are
removed as in `reject`, at once, and for the oldest batch the replayed state is folded exactly as
`foldHeaders` would. Each forgery is then answered in one transaction that also advances the index.
Tests: `test_forgedProofsCannotHoldTheIndex`, refute unit tests, and a refute action in the T12 invariant
suite (forged batches on a real start can always be refuted; honest ones never). The watcher now refutes
right after disputing. The deployed T12 contract predates the fix and keeps the issue until redeployed.

### WUJI-09 — Informational — Accepted — forging costs the attacker only gas (T12)

With a broken verifier, a forged batch costs the attacker gas and nothing else; its disputer is paid from
the relayer reserve, and honest refuters pay header gas (≈ 20k per header). A prover bond would make the
attacker pay, at the price of locking capital for every honest batch. Deferred; revisit with mainnet
economics.

### WUJI-10 — Medium — Fixed — the accounts factory could not create pools on Ethereum or Sepolia

Found 2026-10-01 deploying T11 pools on Sepolia. `WujiAccountsFactory.create(asset)` deployed all three tier
pools in one transaction (≈ 18.5M gas), above the 2^24 per-transaction gas cap of EIP-7825 (enforced on
Sepolia, and on Ethereum after Fusaka): the RPC refused it, leaving a factory with no pools
(`0x5a394b46…A0bc`, recorded as abandoned). Fix: `create(asset, tier)`, one pool per call (≈ 4.25M gas
measured); the menu and create-once rule are unchanged. A test asserts each call stays under the cap.

### WUJI-11 — Medium — Fixed — P2P header source rewound before validating, with no work comparison

Found 2026-10-01 in keeper logs. When a peer answered `getheaders` from a point below our tip, the client
rewound to that point *first* and then appended the peer's headers. A peer on a minority branch (valid work
961632–961639, invalid difficulty at 961640) thus made every keeper and indexer drop ≈ 8,200 validated
headers, fail, and re-download them — several hundred times a day across the running stacks. A lighter but
valid branch would have been adopted outright: there was no cumulative-work comparison, contrary to the
README. Fix (`applyHeaders` in `indexer/bitcoin-p2p.mjs`): a competing branch is built and validated on a
copy, extended while lighter, and adopted only with more cumulative work; an invalid branch leaves the chain
untouched. Tests cover extension, lighter, heavier, invalid, multi-reply and unknown branches. In
production: the ZK keeper (on the fix since 2026-10-01 11:50 UTC) ignored lighter branches forking at
961257, 961286 and 936720 with no rewind; the BSC indexer and keeper and the Sepolia v4 indexer were
restarted on the fix at 2026-10-02 00:48 UTC with their original launch environments (the BSC indexer
had logged 1,086 rewinds before that).

## Verification performed

- 36 Foundry tests pass: unit, 256-run fuzz cases, real BSC hashes, and 64 invariant runs / 3840 calls.
- Invariants cover solvency, matched open supply, whole-pair value, one open series, and fee destination.
- `forge fmt --check` and `forge build --sizes` pass.
- Runtime sizes remain below EVM limits; `WujiVault` is 17,326 bytes in the reviewed build.
- No tracked `.env` or private key was found.
- Slither/Mythril were unavailable in the local environment and remain checklist items.
