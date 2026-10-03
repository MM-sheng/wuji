# Mainnet deployment checklist

Every item is required unless it is explicitly marked informational. Record links, hashes, addresses,
and reviewer names in the release ticket; a checked box without evidence is insufficient.

**Mainnet path (decided 2026-10-02):** `WujiHeaderIndex` (the three T13 rules and nothing else; the ZK proof path stays in `ZkWujiIndex` for testnet research) — valid
headers; a height counts only `CONFIRMATIONS = 100` deep; a branch that out-works the finalized chain by
`CONFIRMATIONS + 144` blocks seals the index — with its own `RelayerRewards` (1/100000 per height) and
`FeeRouter`, and T11 pools priced from the index's newest validated header. No verifier, no challenge
window, no watchers. Design: [T13](tasks/T13_ZK_REORG_EXIT.md); decisions:
[header path first](decisions/2026-10-02-header-path-first.md), [economics](decisions/2026-10-02-submitter-economics.md).
The same shape runs on Sepolia ([manifest](../contracts/deployments/sepolia-t13.json)). The current review entry
point is [REVIEW_HANDOFF.md](tasks/REVIEW_HANDOFF.md) §0.

The relay path (`WujiIndex` + `BitcoinRelay`, T9 frozen exit, YANG/YIN vaults) is kept below as an alternative
and as the vaults' current binding; its items apply only if it ships.

## T13 index gate (mainnet path)

- [x] Decide the confirmation depth and seal rule (K = 100, Bitcoin's coinbase maturity; margin 144) and record why ([T13](tasks/T13_ZK_REORG_EXIT.md)).
- [x] Implement rules 2 and 3, the seen-header record and the header-only keeper mode; test real forks on a test-only low-difficulty subclass (`test/ZkWujiReorg.t.sol`, threshold exact and fuzzed).
- [x] Deploy the exact shape on a public testnet, compare runtime bytecode, and fold live headers ([sepolia-t13.json](../contracts/deployments/sepolia-t13.json)).
- [x] Keep the mainnet contract minimal: `WujiHeaderIndex` carries only the three rules (10,104-byte runtime against 21,990 for `ZkWujiIndex`), with a differential test showing identical state to `ZkWujiIndex`'s header path over 1,000 real headers.
- [ ] Independent review of `WujiHeaderIndex`: `_apply`/`_replay`/`foldHeaders` against Bitcoin Core (compact bits, retarget clamp, MTP, future bound, work) and of `freezeOnReorg` (fork base from `committedAt`, same-chain exclusion, work threshold, difficulty changes inside a branch, gas of the worst real seal).
- [ ] Confirm every transaction the system needs fits the 2^24 per-transaction gas cap (EIP-7825) with margin: folds ≤ 250 heights (≈ 6.4M gas), worst seal ≤ `MAX_REORG_HEADERS` (800, ≈ 15M gas). Re-measure on the target chain.
- [ ] Choose the anchor near the tip at deployment, cross-check its hash and epoch-start time with two independent Bitcoin nodes, and verify `CONFIRMATIONS`, `REORG_MARGIN`, `GENESIS_HEIGHT`, `CHECKPOINT_INTERVAL`, `verifier() == 0` and `committedAt(anchor)` from deployed state.
- [ ] Rehearse a seal on a fork network: a real deep reorg (low-difficulty fork) seals; pools exit through `freezePool`; nothing advances afterwards.
- [ ] Observe at least one full 4320-height series on the testnet deployment, including pool entries and exits processed from headers.

## Consumers on the T13 index

- [x] T11 pools price from `seenHeight` + the age margin (one rule), refuse past 24 h, and keep the pending epochs sorted (`test/WujiAccounts.zk.t.sol`).
- [x] Pools exit through `freezePool` after a seal (`test_aPoolOnTheIndexExitsAfterTheSeal`).
- [ ] First live pool round trip on the testnet: entries at 969672 (2026-10-02) processed from headers; record the result in the manifest.
- [ ] Decide whether YANG/YIN vaults bind to the T13 index (they bind `WujiIndex` + relay today) and review that wiring if so.
- [ ] Independent review of the age-margin table (Poisson, 1.25× rate, 2 h skew) and of `WujiAccountsFactory` one-pool-per-call creation.

## Economics and funding

- [x] Measure gas per submitted header on the target shape (17.6k all-in on Sepolia) and publish the cost by fold frequency ([economics](decisions/2026-10-02-submitter-economics.md)).
- [x] Set the reserve rate so a donation lasts: `BOUNTY_DIVISOR = 100000` (half-life ≈ 1.3 years).
- [ ] Choose the deployment chain(s). Research ([chain choice](decisions/2026-10-03-chain-choice.md)) recommends Ethereum L1 as primary: ≈ USD 37 a month at the 0.067 gwei seen on 2026-10-03 (≈ USD 550 at 1 gwei), two folds a day. An added L2 should be an OP Stack chain (L2 time bound to its L1 origin, ≤ 30 min ahead); Arbitrum's sequencer may set timestamps up to 24 h in the past, which shrinks the pools' age margin. For any L2, document its operator/upgrade trust.
- [ ] Fund the reserve at launch (a donation, not a privilege) and publish the expected runway at the chosen chain's gas prices (≈ USD 850 pays two folds a day at 2026-10-03 L1 gas and 1/100000 per height).
- [ ] Run at least two independent keepers, each with its own RPC and funded key, folding at least twice a day while pools are open.

## Protocol decision (shared)

- [x] Replace timestamp/call-time settlement with a predetermined, recoverable settlement point.
- [x] Update `ARCHITECTURE.md` to match the final settlement rule.
- [x] Implement and disclose the immutable operations reserve and one-off bounty rule ([T1 report](tasks/T1_RESERVE_REPORT.md)); independent release review remains open below.
- [ ] Freeze the collateral address, decimals, `NOTIONAL`, fee, series length, and genesis rule.
- [ ] Document Bitcoin miner private-cost bias, the public-information window and deep-reorg failure for users.

## Review evidence

- [ ] Independent smart-contract review completed against the exact release commit.
- [ ] All high/critical findings fixed and the reviewer has checked the fixes.
- [ ] `forge fmt --check`, `forge build --sizes`, `forge lint`, and `forge test -vvv` pass.
- [ ] Run extended invariants with at least 1,000 runs and 100 depth on the audited production release commit. The v4 test candidate passed [10 seeded 100-run shards at depth 100](tasks/T8_RECOVERY_REPORT.md), with original predicates intact; that does not clear a later native-ETH/production release.
- [ ] Run a static analyzer such as Slither and triage every result.
- [x] Reproduce Bitcoin raw-hash/R/S fixtures: 6060 headers, four retargets, 345 Core-derived timestamp vectors ([T2b report](tasks/T2B_REPORT.md)); independent release review is separate.
- [ ] Review rounding at minimum units and maximum intended TVL.
- [ ] Verify no secret or `.env` file is tracked and the Git worktree is clean.

## Parameters and deployment

- [ ] Tag the audited commit and build from that tag with the pinned compiler/toolchain.
- [ ] Confirm the reviewed release targets Ethereum L1 (`EXPECTED_CHAIN_ID=1`) and independently read the RPC chain id.
- [ ] Implement and independently review the native-ETH collateral path; choosing WETH instead requires an explicit architecture decision.
- [ ] If an ERC-20 collateral release is selected, verify its exact address/code hash and ordinary non-rebasing, non-fee-on-transfer accounting.
- [ ] Confirm `NOTIONAL` is expressed in the collateral's base units.
- [ ] Confirm each vault treasury points to the immutable fee router/reserve, with no owner or rescue key.
- [ ] Implement/review the planned CREATE2 flow, preannounce genesis/anchor/parameters, and simulate deployment against an Ethereum fork with every constructor argument reviewed.
- [ ] Broadcast from a dedicated hardware-backed deployer; do not paste its key into `.env`.
- [ ] Verify source and constructor arguments on Ethereum Etherscan.
- [ ] Compare deployed runtime bytecode with the audited local build.
- [ ] Transfer no production collateral until verification is complete.

## Operations

- [ ] Run a full real-time testnet series through settlement and redemption.
- [ ] Run at least two independent keepers with separate RPC providers and funded keys.
- [ ] Alert on relay lag/staleness, index backlog, deep reorgs, keeper failures, settlement delay and raw-unit solvency mismatch.
- [ ] Publish chain/collateral/notional/series identifiers, contract addresses, Bitcoin genesis height, proof procedure and risk/status pages.
- [ ] Prepare an incident communication plan; immutable contracts cannot be paused or upgraded.
- [ ] Cap initial exposure outside the immutable contracts and increase it only after observation.

## Alternative: relay path (`WujiIndex` + `BitcoinRelay`) — Bitcoin source gate

- [ ] Independently audit BitcoinRelay, especially raw/display byte order, compact target signs/overflow, branch-local epoch time and 2016-height retargets.
- [ ] Compare checkpoint header/hash/height and epoch-start timestamp with two independent Bitcoin nodes. Record normalized versus absolute chainwork convention explicitly.
- [ ] Verify GENESIS_HEIGHT, 6 confirmations, UNIT=1.2e13 and interval=4320 in deployed bytecode/state (relay path; the T13 index uses CONFIRMATIONS = 100).
- [ ] Run complete forge unit/fuzz/invariant suite and Node fixtures/HTTP integration. Keep the original five financial invariants and fail_on_revert enabled.
- [x] Implement MTP/future-time checks and bounded tip-age gating (T2b), with integrated and synthetic shallow-fork gas measurements ([report](tasks/T2B_REPORT.md)). This is not a full Bitcoin node or a proof of global synchronization; worst-case deep-fork liveness still requires review.
- [ ] Observe real relay submissions, six-confirmation fold and a full 4320-height settlement period. No mainnet deployment before independent review.
- [ ] Operate an always-on keystore-signed relayer and an independent data source; no private keys in argv/logs/git.

## Operations-reserve release (T1 rework)

The earlier lifetime-points/DEAD contracts remain a testnet comparison. They do not satisfy this release gate.
Testnet implementation evidence: [T1 reserve report](tasks/T1_RESERVE_REPORT.md), source `e6ec55e`.
The release audit and production-parameter checks below remain separate from successful mock-token exercises.

- [ ] Audit exact reserve/router release, authentication and immutable address bindings.
- [ ] Verify 100% fee routing, token isolation, donation accounting and one-off finalized-height bounties.
- [ ] Prove old work cannot claim future fees; duplicate and orphan heights cannot earn extra bounties.
- [ ] Measure total gas per finalized height and publish reserve size / bounty / primary-market volume assumptions.
- [ ] Exercise permissionless funding, bounded processing and claims against the new testnet deployment.
- [ ] Verify both vault treasuries use the immutable router/reserve, not a personal wallet.

## Review follow-through

- [ ] Confirm terminal and integration docs distinguish index / share / expiry payoff / market price (T0).
- [x] Implement and locally test the T9 frozen-exit candidate, including restoration/re-divergence and one-sided redemption ([design](tasks/T9_DESIGN.md)). This is a source candidate, not a deployed mainnet safeguard.
- [ ] Independently review T9's half-allocation incentive, 144-height candidate delay, reset/griefing risks and exposure policy.
- [x] Integrate T9 terminal/keeper state and complete the local transaction exit drill with unequal holdings and no indexer ([report](tasks/T9_INTEGRATION_REPORT.md)).
- [ ] Deploy the exact independently reviewed T9 release on a separate public testnet and verify a real wallet there. The current candidate has a separate [Sepolia v4 deployment](tasks/T9_SEPOLIA_V4_REPORT.md); independent release review and public MetaMask acceptance remain open. Existing v3 addresses cannot be upgraded.
- [ ] Accept and disclose unallocated reserve/post-freeze fee retention, or separately redesign and review it before mainnet.
- [ ] Complete the 48-hour author-shutdown drill with independent operators and document user exit (T8).
- [ ] Publish conservative exposure policy and its private-cost assumptions; do not label the toy attack threshold a proven safe cap.
