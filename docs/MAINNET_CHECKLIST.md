# Mainnet deployment checklist

Every item is required unless it is explicitly marked informational. Record links, hashes, addresses,
and reviewer names in the release ticket; a checked box without evidence is insufficient.

## Protocol decision

- [x] Replace timestamp/call-time settlement with a predetermined, recoverable settlement point.
- [x] Update `ARCHITECTURE.md` to match the final settlement rule.
- [x] Implement and disclose the immutable operations reserve and one-off bounty rule ([T1 report](tasks/T1_RESERVE_REPORT.md)); independent release review remains open below.
- [ ] Freeze the collateral address, decimals, `NOTIONAL`, fee, series length, and genesis rule.
- [ ] Document Bitcoin miner private-cost bias, the public-information window and deep-reorg failure for users.

## Review evidence

- [ ] Independent smart-contract review completed against the exact release commit.
- [ ] All high/critical findings fixed and the reviewer has checked the fixes.
- [ ] `forge fmt --check`, `forge build --sizes`, `forge lint`, and `forge test -vvv` pass.
- [ ] Run extended invariants with at least 1,000 runs and 100 depth on the release commit.
- [ ] Run a static analyzer such as Slither and triage every result.
- [ ] Reproduce Bitcoin raw-hash/R/S fixtures, at least 3 real retargets and Core-derived timestamp vectors (T2b).
- [ ] Review rounding at minimum units and maximum intended TVL.
- [ ] Verify no secret or `.env` file is tracked and the Git worktree is clean.

## Parameters and deployment

- [ ] Tag the audited commit and build from that tag with the pinned compiler/toolchain.
- [ ] Confirm `EXPECTED_CHAIN_ID=56` and independently read the RPC chain id.
- [ ] Confirm `ASSET` is the canonical BSC collateral contract and record its code hash.
- [ ] Confirm the collateral has ordinary non-rebasing, non-fee-on-transfer ERC-20 accounting.
- [ ] Confirm `NOTIONAL` is expressed in the collateral's base units.
- [ ] Confirm each vault treasury points to the immutable fee router/reserve, with no owner or rescue key.
- [ ] Simulate the deployment against a BSC fork and review every constructor argument.
- [ ] Broadcast from a dedicated hardware-backed deployer; do not paste its key into `.env`.
- [ ] Verify source and constructor arguments on BscScan.
- [ ] Compare deployed runtime bytecode with the audited local build.
- [ ] Transfer no production collateral until verification is complete.

## Operations

- [ ] Run a full real-time testnet series through settlement and redemption.
- [ ] Run at least two independent keepers with separate RPC providers and funded keys.
- [ ] Alert on relay lag/staleness, index backlog, deep reorgs, keeper failures, settlement delay and raw-unit solvency mismatch.
- [ ] Publish chain/collateral/notional/series identifiers, contract addresses, Bitcoin genesis height, proof procedure and risk/status pages.
- [ ] Prepare an incident communication plan; immutable contracts cannot be paused or upgraded.
- [ ] Cap initial exposure outside the immutable contracts and increase it only after observation.

## Bitcoin source gate

- [ ] Independently audit BitcoinRelay, especially raw/display byte order, compact target signs/overflow, branch-local epoch time and 2016-height retargets.
- [ ] Compare checkpoint header/hash/height and epoch-start timestamp with two independent Bitcoin nodes. Record normalized versus absolute chainwork convention explicitly.
- [ ] Verify GENESIS_HEIGHT, 6 confirmations, UNIT=1.2e13 and interval=4320 in deployed bytecode/state.
- [ ] Run complete forge unit/fuzz/invariant suite and Node fixtures/HTTP integration. Keep the original five financial invariants and fail_on_revert enabled.
- [ ] Implement MTP/future-time checks and the catch-up gate (T2b); measure their integrated gas and fork-rewiring cost. Do not call this a full Bitcoin node.
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
- [ ] Implement and adversarially analyse immutable frozen-state exit for one-sided holders (T9).
- [ ] Complete the 48-hour author-shutdown drill with independent operators and document user exit (T8).
- [ ] Publish conservative exposure policy and its private-cost assumptions; do not label the toy attack threshold a proven safe cap.
