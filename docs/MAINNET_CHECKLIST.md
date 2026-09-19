# Mainnet deployment checklist

Every item is required unless it is explicitly marked informational. Record links, hashes, addresses,
and reviewer names in the release ticket; a checked box without evidence is insufficient.

## Protocol decision

- [ ] Replace timestamp/call-time settlement with a predetermined, recoverable settlement point.
- [ ] Update `ARCHITECTURE.md` to match the final settlement rule.
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
