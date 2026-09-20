# T1 rework — operations reserve and one-off bounties

Branch: `codex/operations-reserve`, following the 2026-09-20 adversarial review.
Status: implementation and local validation complete; independent review remains pending.
The initial source edits were included in the concurrent task-planning commit `8d792a6`; this branch completes
integration, tests, keeper operation and deployment evidence. The new Ethereum/ETH/ZK target tasks are preserved.

## Delivered behaviour

- 100% fee routing, no DEAD transfer, no perpetual points. Each selected token pays floor(reserve/10000) for
  each newly folded height. The reserve shrinks sequentially; splitting a batch gives exactly the same result.
- Only the immutable index can register the next contiguous range. The index has already checked six-deep
  canonical headers and its previous hash. No-op folds, duplicates and replaced pre-finality forks earn nothing.
- The folder selects up to eight sorted unique assets, at most 256 rewarded heights. No arbitrary token enumeration
  or token callbacks during allocation. Unselected/empty-reserve/plain-fold heights create no future entitlement.
- Claimable amounts are fixed at completion. New fees, later donations and delayed claims cannot increase old
  entitlements. Anyone can fund; unsynchronized direct transfers enter the reserve only on fund/sync.
- Optional atomic submitAndFold avoids exposing two separate operations to a competing folder. The outer caller
  receives the allocation; standalone submit/fold remain available. Whole-transaction competition remains possible.
- The keeper handles reserve manifests explicitly, uses operator-configured tokens, normally submits/folds atomically,
  and collects fees/claims every 144 heights by default. Smallest-unit transfers no longer force a transaction every poll.
- The vault's financial code, original invariant file, pair rule, fees, UNIT, confirmations and series length are preserved.
  Only the vault's outdated NatSpec changed. No owner, rescue, setter or upgrade mechanism was added.

Permissionless ordinary-token funding and a nonzero reserve do not guarantee profitability. In particular a bare
fold can advance the index without taking a bounty, and a standalone relayer can lose the folding reward to another
account. Less than 10000 base units pays zero. A depleted pool needs new fees/donations, not old-work claims.

## Validation

- 92 Solidity tests across 9 suites passed, 0 failures/skips. Original financial invariants kept byte-for-byte,
  64 runs × 60 calls, fail_on_revert=true; new reserve invariant also completed 3840 calls without reverts.
- Reserve invariant checks funding = unused reserve + fixed unpaid allocations + paid claims for two tokens and
  three workers, with a per-height reference ledger. Unit/fuzz tests cover splitting, rounding, new funding vs old
  work, token-selection limits, duplicate ranges, delayed/repeated claims and permissionless donors.
- Token failures, reentry, sender surcharge, receiver transfer fee and external balance loss are tested. An abnormal
  token cannot block allocation in another token; no test claims arbitrary ERC-20s are safe.
- Integrated tests cover real headers, original JS/Solidity byte equivalence, shallow/deep forks, original submission
  attribution, atomic caller attribution and full rollback of headers/checkpoints/allocations on failure.
- T2's 2028-header differential comparison and <=70k routine-header regression assertions still pass. The frozen
  baseline's code is unchanged except its import now points to a test-only historical rewards ABI.
- All 4 Node Bitcoin fixture, adapter and HTTP persistence/reorg tests passed. Keeper/verifier syntax and startup-shell
  syntax checks passed. Source comparison confirmed unchanged financial logic after removing comments/whitespace.
- Production runtime sizes: relay 5942, index 4085, reserve 4191, router 1115, vault 9509 bytes; all below EIP-170.

## Gas and economics

Solidity 0.8.28, optimizer 200; execution measurements below exclude transaction intrinsic/calldata gas.

| Operation | Execution gas |
|---|---:|
| Relay steady 24-header batch, per header | 68068 |
| Relay new-worker 24-header batch, per header | 69918 |
| First 24-header batch at retarget, per header | 71955 |
| Fold 16 heights, one reward token, per height | 18177 |
| Fold 16 heights, two reward tokens, per height | 18342 |
| Atomic submit/fold, first single height, two tokens | 358266 |
| Atomic submit/fold, following single height, two tokens | 197062 |
| Atomic submit/fold, following 16-height batch, per height | 78572 |
| One fixed-amount claim | 82462 |

Use the single-height measurement for normal ~10-minute following; batch cost applies to catch-up and must not
be presented as every live transaction's cost. Initialization/fork rewrites and T2b additions can cost more.
The 250k/height operating-budget scenario, explicit gas-price assumptions, reserve adequacy, fee-bearing volume
and zero-revenue decay are in ARCHITECTURE §4. Reproduce with `node scripts/keeper-economics.mjs`.
No live asset-price claims or future ZK savings are included in that budget.

## Testnet delivery

Deployment/bytecode verification and live relay/fold/claim receipts will be recorded here after confirmation.
The prior :8790 stack remains a historical comparison; no mainnet deployment is part of this task.
