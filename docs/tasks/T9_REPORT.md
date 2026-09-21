# T9 · Frozen-state exit candidate

Branch: `codex/frozen-exit`. Baseline: `c8ea538` (T7). Date: 2026-09-21.

## Delivered

- [T9_DESIGN.md](T9_DESIGN.md): exact state machine, checkpoint selection, 144-height test-candidate delay,
  attacker incentive analysis, liveness limits and deployment boundaries. This is not mainnet approval.
- `BitcoinRelay.reorgCount`: increases when a higher-work non-extension becomes canonical; ordinary extensions
  and losing branches do not invalidate an observation. Intermediate restoration/re-divergence is detectable.
- `WujiIndex`: permissionless mismatch observation binds folded height/hash and relay height/tip/revision.
  The deadline is `max(observed relay height, folded height)+144`. Repeated valid reports do not reset it;
  branch changes, changed folded state or restored consistency invalidate it. `freeze()` seals the index only
  after a still-valid notice and sufficient height progress. No elapsed-time or stale-relay shortcut exists.
- `WujiVault`: mismatch/frozen guards on mint and ordinary settlement; `settleFrozen()` preserves the own
  recorded maturity payoff or uses half if unavailable, closes the current series and opens no successor.
  Existing settled claims, paid amounts, paired redemption, fees, rounding and fee destination are preserved.
- Unit/fuzz tests, an additional terminal-state invariant handler and actual fork-choice integration with the
  existing explicitly test-only easy-PoW relay. Production relay validation is not weakened.
- Architecture, threat model, README, task queue and mainnet gates distinguish source candidate from existing
  immutable v3 deployments. The old financial tests, original fixtures and invariant configuration are unchanged.

## Validation

| Check | Result |
|---|---|
| Complete Foundry suite | **134 passed**, zero failed or skipped, 13 suites |
| Node suite | **84 passed**, zero failed or skipped |
| Original financial invariants | Unmodified; 64 runs × 60 depth, fail-on-revert retained |
| New terminal-state invariants, standard run | 64 runs × 60 calls, zero reverts |
| New terminal-state invariants, extended run | **1000 runs × 100 calls = 100000 calls**, zero reverts |
| Forced handler path | Reaches terminal state, redeems both unmatched holders, checks conservation and non-reopening |
| Reproducible local deployments | **8 actual Anvil runtimes matched**, fresh builds from two checkout paths; tampered runtime rejected |
| Whitespace / unchanged-file checks | `git diff --check` passes; prior tests/fixtures, deployment manifests, indexer and terminal unchanged |

Foundry groups each contract's stateful invariants as one suite test, so the 134 count is not a count of individual
random calls. The new handler checks solvency/conservation, paired open supply, complementary values, zero or one
open series according to terminal state, fixed sealed index state and non-reopening. The extended run applies to
this new handler only; it does **not** satisfy the separate requirement for extended testing of the whole audited
release. No mainnet checklist item for an extended full-release audit was checked off.

Key adversarial cases include healthy/empty/stale rejection, missing notice, deadline off-by-one, repeated reports,
clock-only waiting, ordinary restoration, unobserved restoration/re-divergence, a further shallow winning fork,
losing fork non-invalidation, shorter higher-work branches, observation-head binding, delayed/late-created vaults,
old payouts, rounding, and atomic submission rollback after sealing. Historical production PoW, difficulty,
timestamp and integer-equivalence suites still run separately from synthetic economic/branch feeders.

### Runtime sizes

`forge build --root contracts --sizes` passes. All production runtimes remain below the 24576-byte EIP-170 limit.

| Contract | Runtime bytes |
|---|---:|
| BitcoinRelay | 6932 |
| WujiIndex | 6779 |
| WujiVault | 10860 |
| WujiVaultFactory | 16668 |

### Exit execution measurements

The funded half-fallback test measured the following **test-warm execution gas** with existing state in the same
Foundry test transaction. Values exclude transaction intrinsic/calldata costs and are neither cold-transaction
estimates nor arbitrary-path upper bounds. The existing batch/real-header gas regression tests also passed.

| Call | Execution gas |
|---|---:|
| observeReorg | 138395 |
| freeze | 77217 |
| settleFrozen, half fallback | 93721 |

## Economic and operational limits

Half allocation can benefit the formerly losing side. Relative to a stipulated counterfactual expiry share a,
the gross difference is `N*(qY-qN)*(0.5-a)`, bounded in absolute value by half of unhedged notional in that collateral.
This is not a live-price profit estimate. External positions can increase incentive, and 144 relayed heights do
not force the attacker to bear 144 blocks of private mining cost. No safe TVL or self-sustaining operation is proven.

Further winning forks restart observation, so shallow-fork griefing remains possible after the initial failure.
Without a relayer, the height deadline cannot advance. Exit callers pay gas without a new bounty. Existing reward
allocations remain claimable, but unallocated reserve/post-freeze fees may be stranded because the sealed index
cannot allocate future fold bounties. There is no owner rescue or historical-worker claim on new fees.

These are recorded tradeoffs, not undisclosed changes to fee routing or promises of a universally fair exit.
Independent review of the exact source, fallback and delay parameter is required before mainnet.

## Reproduction and release boundary

```bash
forge test --root contracts
forge build --root contracts --sizes
FOUNDRY_INVARIANT_RUNS=1000 FOUNDRY_INVARIANT_DEPTH=100 \
  forge test --root contracts --match-contract FrozenExitInvariants -vv
forge test --root contracts --match-test test_exitExecutionGas -vv
node --test indexer/*.test.mjs scripts/*.test.mjs apps/terminal/*.test.mjs
node scripts/test-bytecode.mjs
```

Only temporary local Anvil deployments were created, using unlocked disposable local accounts. No private keys
were read, public-network transactions sent or existing services restarted. Testnet manifests and addresses are
unchanged. Current-source runtime checks against old v3 deployments should fail; use the original source such as
`c8ea538` when checking those addresses.

Next: review the candidate, deploy a separate testnet release, add explicit keeper/terminal observation and closure
states, and exercise user-owned single-sided withdrawals. The current running v3 stack still has no T9 exit.
T4's full live dual-source reconstruction, T8's disappearance drill, long-period settlement and independent audit
remain outstanding. The new candidate is not an upgrade of any previously deployed contract.
