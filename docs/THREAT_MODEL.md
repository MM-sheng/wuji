# WUJI threat model

Status: testnet prototype. This document describes the current contracts, not a claim that they
are ready to custody production funds.

## Security objective

For every series, one fully backed pair represents exactly one `NOTIONAL` of collateral. At all
times the vault balance must cover the sum of all open and settled claims. No privileged account
may change the index, mint claims, withdraw collateral, pause users, or upgrade the contracts.

## Trust boundaries

- **BNB Chain consensus and block production:** block hashes are the sole index input. Validators
  cannot choose arbitrary hashes, but block hashes are not an unbiased randomness beacon and a
  proposer may have limited withholding/reordering influence.
- **EIP-2935 history contract:** hashes older than 256 blocks depend on the canonical history
  contract at `0x0000F90827F1C53a10cb7A02335B175320002935`.
- **Collateral:** solvency is denominated in units of the configured ERC-20. Depeg, issuer freeze,
  blacklist, proxy upgrade, or chain bridge failure remain collateral risks.
- **Keeper:** the keeper has no authority; it only calls public functions. Its key can waste its
  own gas. Loss of all keepers can cause deterministic zero-increment gaps.
- **Indexer and UI:** caches only. They may lie or fail without changing contract state. Users must
  be able to compare their result with public RPC data.
- **DEX pools:** secondary prices depend on liquidity and can diverge from claim value. Pair
  mint/redeem constrains the sum of YANG and YIN, but does not guarantee either side trades at its
  displayed claim value before settlement.

## Mainnet blockers

### Settlement checkpoint — implemented, pending independent review

Series use deterministic block-number boundaries derived from immutable deployment parameters.
`WujiIndex` stores S when each boundary is folded, and `WujiVault` reads only that value. Calling
`settle()` later cannot change the payoff. Missing boundary hashes follow the existing frozen-gap rule,
so the checkpoint remains recoverable. This remediation has unit and invariant coverage but still
requires an independent review against the release commit.

### Independent review — unresolved

The contracts have internal unit, fuzz, and invariant coverage, but no independent audit or formal
verification. At least one reviewer who did not author the contracts must review source, deployment
parameters, compiler settings, and the final deployed bytecode.

## Defences implemented

- No owner, proxy, pause, governance, or arbitrary withdrawal path.
- `ReentrancyGuard` and `SafeERC20` protect vault entry points and token calls.
- Minting measures the vault balance delta and rejects fee-on-transfer collateral.
- Settlement reads a predetermined checkpoint. If that boundary is more than one bounded tick away,
  callers advance the index separately; the index need not catch up to a later chain head.
- Missing hashes outside the 8191-block history window contribute exactly zero and emit `Gap`.
- Mint fees round up; payouts and redemption fees round down in the vault's favour.
- Deployment requires an explicit chain id, treasury, and production collateral. Mock collateral is
  available only behind an explicit test flag.

## Failure modes that remain by design

- A gap changes the realized path by freezing missing increments at zero.
- At `yangShare` 0 or 1, one side has no settled claim; the payoff is bounded rather than an
  unbounded replica of `100 * exp(S)`.
- `liabilities()` grows linearly with the number of series and is intended as a view/monitoring call.
- Treasury is immutable and receives protocol fees. Compromise cannot drain vault collateral, but
  the recipient and its control policy must be disclosed.
- Tokens that rebase, blacklist the vault, return dishonest balances, or otherwise violate ordinary
  ERC-20 semantics are unsupported even if deployment succeeds.

## Monitoring signals

Alert on `Gap`, keeper transaction failures, `pending() > 256`, a mined settlement block without settlement, vault
balance below `liabilities()`, unexpected collateral implementation changes, and any mismatch between
the indexer's `S_wad` and `WujiIndex.S()`.

## Bitcoin source migration · 2026-09-20

- **Checkpoint trust:** header, height and epoch-start timestamp must be compared against independent Bitcoin sources. A fake epoch timestamp can distort the first retarget. Chainwork is normalized to the checkpoint block's own work; the omitted common prefix cancels in every fork comparison. It is not the absolute chainwork reported by Core.
- **Miner bias:** after finding a header a miner can compute R and discard an unfavorable block. The expected opportunity cost depends on rewards, fees, hash share and external payoff; it is not a universal fixed one-block-reward lower bound. Rehashing removes raw PoW bit-pattern bias; it does not prove perfect randomness or economic independence.
- **SPV boundary:** work, parent linkage, mainnet retarget rules and cumulative-work fork selection are enforced. Transactions, block validity, MTP and future-time constraints are not. A header-only fork may be invalid to Bitcoin full nodes. Timestamp manipulation can affect subsequent target and work per block, but cannot manufacture the cumulative target-derived work needed to win. There is no promise of full consensus equivalence.
- **Deep reorg:** six blocks is a probabilistic safety margin. If a heavier branch replaces a folded height, fold reverts even when no new heights are pending. Already executed payouts cannot be undone. No owner recovery/upgrade is introduced; deployment and application recovery require explicit new design.
- **Availability:** public API failure or dishonest data can stall or mislead the off-chain view. The relay independently checks PoW and difficulty. Local Core/Esplora endpoints are supported; use independent sources to compare checkpoints and live results. Never treat an HTTP success as proof of Bitcoin consensus.
- **Gas/liveness:** reorg rewiring is proportional to changed branch depth; extremely deep branches can exceed a transaction gas budget. The current storage design exceeds the 60k/header target. These limits must be resolved or explicitly accepted before mainnet.
- **Test boundary:** synthetic feeder headers in economic invariants do not validate mining. Production relay tests use 2028 real headers and invalid mutations; branch-choice unit tests use an easy-PoW subclass that is not deployed.

## T1 fee router and relayer rewards

- Fee destination: immutable 50% lifetime relayer points / 50% DEAD address. Sending a token to DEAD does not imply totalSupply burning.
- Relay credits are deferred until the index folds the six-deep canonical height. Transient orphan headers earn no points. The original submitter receives the point even when another account extends its branch or folds it. Known/duplicate headers cannot overwrite attribution. Front-running a new valid header is accepted competition, not double payment.
- An already-paid height is never paid again. A deep reorg prevents index folding, but cannot reverse previously claimed rewards, matching the existing settlement limitation.
- Work weights are fixed at one point per submitted finalized header and one per folded height, independent of actual gas price/cost. Lifetime points dilute new workers and do not guarantee economical liveness. Empty fee pools pay nothing; no subsidy or guaranteed yield exists.
- Funding allocation occurs at sync, not at ERC-20 transfer time. Anyone can trigger sync. Fees arriving before any work are allocated on a later sync with positive points. This timing is explicit and not an oracle for transaction-level fee timing.
- Per-token accumulators and per-worker lots prevent new work from taking previously synchronized rewards. Bounded claim catch-up prevents a long work history from requiring one unbounded transaction. Precision dust remains reserved; no rescue key exists.
- No credit path calls arbitrary ERC-20 code. Tokens which rebase, charge transfer fees, lie about balances, blacklist recipients or revert remain unsupported; their failure can block their own routing/claims, not other tokens or header credit. Fee router/reward token entrypoints have reentrancy guards.
- CREATE nonce prediction is security-critical: deployment assertions and post-deploy address checks must bind rewards.relay/index and relay/index.rewards. No binding may be changed after deployment.

## T2 compact representation

Work remains bounded to uint128 and height to uint32, checked in wider arithmetic before narrowing.
Node, epoch and worker IDs are checked before exhaustion; no wraparound or record alias is permitted.
Parent hash compression relies ONLY on the existing Bitcoin-mainnet PoW_LIMIT of 2^224-1, with an explicit
range check and lossless round-trip tests. It is not appropriate for a chain with a looser PoW limit.

Two node metadata records share a word. IDs are never reused, so insertion only fills a previously empty half.
Branch-local epoch records are immutable. Within an epoch, baseWork + offset * blockWork is exact; a retarget
creates a separate record with the new baseWork/bits/firstTime. Arbitrary checkpoint heights preserve the real
epoch-start timestamp independently of the work baseline. Differential fixtures and shorter/heavier forks test this.

Work reconstruction and worker lookup remain constant-time; no unbounded scan was moved into reward claims.
Header submission makes no untrusted callbacks, so committing the cached best tip at batch end is atomic.
Synthetic easy-target tests alone store full parents separately because their hashes violate the mainnet bound.
The production deployment has no such alternate storage path. Gas targets apply to measured batches, not arbitrary
fork rewrites, first-worker setup, or single-header transactions. Independent review must include the compact encoding.
