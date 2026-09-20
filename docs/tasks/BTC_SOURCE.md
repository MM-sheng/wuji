# Task brief: make Bitcoin proof-of-work the source of WUJI's path

Status: **decided 2026-09-20**. This brief is self-contained; read `docs/ARCHITECTURE.md` for the
product and `AGENTS.md` for repo conventions before starting. Ask nothing that this file answers.

## Decision

WUJI's settlement index is defined by **Bitcoin block hashes**, independently of the chain hosting its
contracts. An 80-byte header lets a relay check PoW and links without a privileged submitter; it does not
prove full block validity. Miners learn a valid hash when they find it and can selectively publish it at a
private cost that depends on their circumstances. A shared settlement index supports a family of separate
claims across chains, not fungibility or synchronized finality. Late submission delays availability without
skipping Bitcoin heights or changing their increments. This wording incorporates the 2026-09-20 review;
the path parameters below are unchanged. T2b in NEXT supersedes the original permission to omit timestamp checks.

## Path definition (normative)

```
for each Bitcoin height h ≥ GENESIS_HEIGHT (main chain, ≥ CONFIRMATIONS deep):
    R_h        = sha256(blockhash_h)                     // blockhash as the 32-byte header hash, internal byte order (little-endian as hashed)
    delta_h    = byteSum(R_h) − 4080                     // byteSum = sum of the 32 bytes, identical to WujiIndex.byteSum today
    U_h        = U_{h−1} + delta_h                       // exact integer, U_{GENESIS−1} = 0
    S_h        = U_h · UNIT                              // UNIT = 1.2e-5  (contract: 1.2e13 wad)
    display_h  = 100 · e^{S_h}                           // off-chain index display, not a token market price
```

- Re-hashing is required: PoW restricts raw hashes to a target-dependent numerical interval, biasing their byteSum.
  See WUJI_FOUNDATIONS §8; leading-zero counts depend on difficulty.
- UNIT: assuming 144 blocks/day and ideal independent uniform re-hashed bytes, byteSum sd ≈ 418.04 →
  σ_block ≈ 0.50 %, ≈ 6 %/day. byteSum has finite discrete support; these are model estimates, not fixed daily volatility.
- Byte order: use the header hash exactly as produced by `sha256d(header)` (32 bytes, the order in which the
  EVM contract will compute it). The indexer must use the same order — write a test with a known block
  (e.g. height 800000) asserting the same `R_h` in Solidity and JS. Document the order in the contract NatSpec.
- CONFIRMATIONS = 6. A height contributes once the relay's heaviest chain is ≥ 6 blocks past it.
- Checkpoints (series boundaries) are defined on **Bitcoin heights**: `GENESIS_HEIGHT + k·CHECKPOINT_INTERVAL − 1`,
  CHECKPOINT_INTERVAL = 4320 (≈ 30 days). The index records `S` at each boundary height when that height finalizes.

## Contracts to write (`contracts/src/`)

### `BitcoinRelay.sol` — minimal SPV header chain, permissionless

- `constructor(bytes80 checkpointHeader, uint64 checkpointHeight, uint32 epochStartTime, uint256 checkpointChainWork)`:
  a trusted starting header at an arbitrary height plus what is needed to validate the next retarget. Anyone can
  audit the checkpoint against Bitcoin; it is an immutable deployment parameter like GENESIS_HEIGHT.
- `submit(bytes calldata headers)`: one or more consecutive 80-byte headers. For each: parse; `prevHash` must be a
  known header; `sha256d(header)` ≤ target(nBits); at heights `% 2016 == 0` recompute the expected nBits from the
  previous epoch's first/last timestamps with the ×4/÷4 clamp and require equality; otherwise nBits must equal the
  parent's. Track cumulative chain work; the heaviest chain is the main chain; forks are allowed and resolved by
  work. Keep `heightOf`, `headerAt(height)` for the main chain, `bestHeight`, `bestHash`, `chainWork`.
- Timestamp rules (median-time-past, future limit) MAY be skipped; document that omission and why it cannot be
  used to fake work.
- Use `sha256` precompile; no external libraries unless already vendored under `lib/` (OpenZeppelin is; you may
  vendor Summa `bitcoin-spv` if you keep the licence notice, but prefer ~200 lines of your own with tests).
- Target gas: ≤ 60k per header amortised in a batch. Report actual numbers in the PR.

### `WujiIndex.sol` — replace the blockhash engine

- Reads finalised main-chain headers from the relay, folds `delta_h` into `S` in height order (`fold(uint256 max)`
  anyone can call, bounded per call, no-op when nothing new is final). No `frozenBlocks`, no `Gap`, no
  `HISTORY` contract, no EIP-2935.
- Keeps: `UNIT`, `MEAN`, `byteSum`, `increment(bytes32 R)`, `S`, `lastHeight`, `GENESIS_HEIGHT`,
  `CHECKPOINT_INTERVAL`, `nextCheckpointHeight`, `checkpointS(height)`, `checkpointed(height)`.
- Reorg rule: only heights ≥ 6 deep are folded. If the relay's main chain changes
  below the folded height (a >6-block reorg), `fold` MUST revert with a clear message rather than continue; this is
  a documented failure mode, not an impossible event. Prior payments cannot be undone; T9 must define frozen-state exit.

### `WujiVault.sol`, `WujiVaultFactory.sol`, `SeriesToken.sol`

- Series boundaries become Bitcoin heights (`startHeight`, `settlementHeight`). `mint` closes once
  `index.lastHeight() >= settlementHeight` (the boundary is final on-chain). `settle()` reads the checkpoint as today.
- Constructor no longer ticks an unbounded backlog; keep the "index backlog: fold first" guard pattern.
- Nothing else changes. All existing invariants must still hold; keep the invariant suite green.

## Off-chain (`indexer/`)

- `index.mjs`: add `SOURCE=bitcoin`. Fetch headers from a Bitcoin data source (default public
  `https://mempool.space/api` and `https://blockstream.info/api`, env-overridable to a local `bitcoind` REST
  endpoint). Compute the path exactly as above; `/proof/:height` returns header hash, `R_h`, `delta_h`, `U`, `S`,
  the wad `S` the contract must hold, and a link to `https://mempool.space/block/<hash>`. Remove Gap mirroring in
  this mode. Keep `/seconds` (price per second = price of the latest final height at that second) so the terminal
  keeps working unchanged.
- `keeper.mjs`: becomes a header relayer: fetch new headers, `submit` them in batches (e.g. up to 24), then
  `fold`, then `settle` vaults whose boundary is final. Signs via the Foundry keystore as today; never puts a key
  on a command line.

## Terminal (`apps/terminal/index.html`)

- Show the step-wise nature honestly: the last Bitcoin height, its hash (click → mempool.space), time since the
  last block, and expected next block; candles are fine (they will just be flat between blocks).
- Keep paper trading, monkey, news, TA, time travel, leverage. Replace "block #… BscScan" provenance with the
  Bitcoin height/hash.

## Tests (must pass in CI: `forge test` in `contracts/`)

1. Real-header fixtures: at least 2016+12 consecutive mainnet headers spanning a retarget (fetch once with a
   script into `contracts/test/fixtures/`, commit the fixture; document the source and how to regenerate).
   Relay must accept them, reject a header with a flipped bit, reject a wrong nBits at the retarget, and pick the
   heavier of two forks.
2. Cross-implementation equality: JS (`indexer`) and Solidity compute identical `R_h`, `delta_h`, `U`, `S` over the
   fixture range. Reuse `scripts/check-real-hashes.sh` as the pattern.
3. Vault invariants unchanged (solvency, paired supply, pair wholeness, one open series, fee routing), driven by
   header submission instead of `vm.setBlockhash`.
4. Reorg: a 3-block fork that becomes heavier is followed; a fork below the folded height makes `fold` revert.

## Deliverables and acceptance

- PR(s) against `main` with: contracts + tests, indexer/keeper changes, terminal changes, updated
  `docs/ARCHITECTURE.md` (§1 index, §2 checkpoints, §4 contracts, remove the frozen-gap text, add a decision record
  "2026-09-20: source = Bitcoin PoW"), updated `docs/THREAT_MODEL.md` (miner bias cost, relay checkpoint trust,
  deep-reorg rule, data-source liveness) and `docs/MAINNET_CHECKLIST.md` (checkpoint header verification step).
- Gas table in the PR description: per-header submit (cold/warm), per-height fold, settle.
- Deployed to BSC testnet via `contracts/scripts/deploy-testnet.sh` (extend it: relay checkpoint from a recent
  Bitcoin height; the keystore flow in `set-key.sh` is already in place). Record addresses in
  `contracts/deployments/bsc-testnet.json`. A Sepolia deployment is welcome but optional.
- Do not touch: the fee rate, the pair rule (`½ + ½·ΔS`, fixed base), the no-owner/no-upgrade stance, the
  MIT licence, the zero-dependency indexer.

## Parameters (deployment-time, immutable)

| name | value | note |
|---|---|---|
| GENESIS_HEIGHT | the Bitcoin height current at deployment | document it |
| CHECKPOINT_INTERVAL | 4320 | ≈ 30 days |
| CONFIRMATIONS | 6 | |
| UNIT | 1.2e13 wad | ≈ 6 %/day at 144 blocks/day |
| relay checkpoint | a header ≤ 2016 blocks before GENESIS_HEIGHT | so the first retarget after genesis is verifiable |

## Open questions you may decide yourself (state the decision in the PR)

- Whether `fold` is called automatically at the end of `submit` (cheaper for relayers) or kept separate.
- Fixture height range for tests.
- Whether the relay stores full headers or only hashes + the fields needed for retarget validation.

## Implementation review entry

The Bitcoin branch's implementation and testnet evidence are documented in
[`../BTC_SOURCE_REPORT.md`](../BTC_SOURCE_REPORT.md), including unmet gas target, pending live confirmations and PR remote requirement. Normative acceptance criteria above remain unchanged.
