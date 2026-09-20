# Mainnet deployment checklist

Every item is required unless it is explicitly marked informational. Record links, hashes, addresses,
and reviewer names in the release ticket; a checked box without evidence is insufficient.

## Protocol decision

- [x] Replace timestamp/call-time settlement with a predetermined, recoverable settlement point.
- [x] Update `ARCHITECTURE.md` to match the final settlement rule.
- [ ] Decide and publicly disclose the immutable treasury recipient and its control policy.
- [ ] Freeze the collateral address, decimals, `NOTIONAL`, fee, series length, and genesis rule.
- [ ] Document BNB validator influence and the deterministic frozen-gap rule for users.

## Review evidence

- [ ] Independent smart-contract review completed against the exact release commit.
- [ ] All high/critical findings fixed and the reviewer has checked the fixes.
- [ ] `forge fmt --check`, `forge build --sizes`, `forge lint`, and `forge test -vvv` pass.
- [ ] Run extended invariants with at least 1,000 runs and 100 depth on the release commit.
- [ ] Run a static analyzer such as Slither and triage every result.
- [ ] Reproduce real BSC hash fixtures and confirm chain/indexer/contract equality.
- [ ] Review rounding at minimum units and maximum intended TVL.
- [ ] Verify no secret or `.env` file is tracked and the Git worktree is clean.

## Parameters and deployment

- [ ] Tag the audited commit and build from that tag with the pinned compiler/toolchain.
- [ ] Confirm `EXPECTED_CHAIN_ID=56` and independently read the RPC chain id.
- [ ] Confirm `ASSET` is the canonical BSC collateral contract and record its code hash.
- [ ] Confirm the collateral has ordinary non-rebasing, non-fee-on-transfer ERC-20 accounting.
- [ ] Confirm `NOTIONAL` is expressed in the collateral's base units.
- [ ] Confirm `TREASURY` twice, including its signer/recovery policy.
- [ ] Simulate the deployment against a BSC fork and review every constructor argument.
- [ ] Broadcast from a dedicated hardware-backed deployer; do not paste its key into `.env`.
- [ ] Verify source and constructor arguments on BscScan.
- [ ] Compare deployed runtime bytecode with the audited local build.
- [ ] Transfer no production collateral until verification is complete.

## Operations

- [ ] Run a full real-time testnet series through settlement and redemption.
- [ ] Run at least two independent keepers with separate RPC providers and funded keys.
- [ ] Alert on index backlog, `Gap`, keeper failures, settlement delay, and solvency mismatch.
- [ ] Publish contract addresses, genesis block, proof procedure, risk disclosure, and status page.
- [ ] Prepare an incident communication plan; immutable contracts cannot be paused or upgraded.
- [ ] Cap initial exposure outside the immutable contracts and increase it only after observation.

## Bitcoin source gate

- [ ] Independently audit BitcoinRelay, especially raw/display byte order, compact target signs/overflow, branch-local epoch time and 2016-height retargets.
- [ ] Compare checkpoint header/hash/height and epoch-start timestamp with two independent Bitcoin nodes. Record normalized versus absolute chainwork convention explicitly.
- [ ] Verify GENESIS_HEIGHT, 6 confirmations, UNIT=1.2e13 and interval=4320 in deployed bytecode/state.
- [ ] Run complete forge unit/fuzz/invariant suite and Node fixtures/HTTP integration. Keep the original five financial invariants and fail_on_revert enabled.
- [ ] Resolve or explicitly accept >60k/header gas, deep-reorg rewiring cost and omitted MTP/future-time checks. Do not call this a full Bitcoin node.
- [ ] Observe real relay submissions, six-confirmation fold and a full 4320-height settlement period. No mainnet deployment before independent review.
- [ ] Operate an always-on keystore-signed relayer and an independent data source; no private keys in argv/logs/git.
