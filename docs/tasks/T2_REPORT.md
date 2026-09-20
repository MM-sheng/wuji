# T2 — relay storage and gas validation

Branch: `codex/relay-packing`, following T1 `143592b` and initial packing `d82cc80`.
The initial two-slot Node saved 19.73% but could not meet the target while persisting every field separately.
The final representation below stores the same observable header history with shared epoch and worker records.

## Exact storage representation

- `links[rawHash]`: 224-bit numeric parent hash plus a 32-bit immutable node ID. Mainnet PoW_LIMIT is
  2^224−1, so the parent hash's discarded 32 bits are provably zero for validated mainnet headers.
  Encoding explicitly checks that bound; decoding restores all 256 bits and reverses back to raw digest order.
- Per-node metadata is 128 bits: uint32 height, timestamp, epoch ID and worker ID. Two immutable records
  share one storage word. Insertion ORs only the previously unused half. Duplicate headers allocate nothing.
- Each branch-local difficulty epoch stores its base height/work, first timestamp, nBits and exact work per block.
  `chainWork(h) = baseWork + (height(h) − baseHeight) × blockWork`. This is integer identity within a constant-
  difficulty epoch, not an estimate. A retarget creates a fresh record for that branch, even when nBits matches another branch.
- A checkpoint midway through an epoch uses its own height/work as the work baseline, but preserves the actual
  epoch-start timestamp for the NEXT retarget. The index genesis and UNIT are unchanged.
- Worker addresses are stored once, referenced by ID. `submitter(hash)` remains constant-time and returns the
  original worker for canonical AND orphan headers. Checkpoint/unknown hashes return zero. No parent-walk claims.
- `main[height]` retains full raw hashes. Fork choice, PoW, retarget clamps, batch/parent checks and six-deep
  reward attribution remain unchanged. Cached batch tip state is committed only after all headers pass.

This refines NEXT.md's suggested literal Node layout: some per-node fields are now reconstructed exactly
from shared records. It adds no owner, mutable policy, dependencies, caller-supplied work or weakened validation.

## Gas

Solidity 0.8.28, optimizer 200, unchanged compiler settings. Test-body execution gas, excluding transaction
intrinsic and calldata gas. All reward-enabled measurements use the production reward wiring.

| Operation | T1 | Initial T2 | Final |
|---|---:|---:|---:|
| First single header at retarget, rewards disabled | 165589 | 138941 | 219009 |
| Following 24 headers, same worker, rewards disabled | 125233 | 100500 | 68059 |
| First batch of 24 at retarget, rewards enabled | 125345 | 100612 | 71748 |
| Steady 24-header batch, rewards enabled | — | — | 68069 |
| 24-header batch by a newly registered worker, rewards enabled | — | — | 69919 |
| Fold per height, rewards enabled (16 heights) | 100712 | 100712 | 102771 |
| Fold per height, rewards disabled (19 heights) | 12098 | 12098 | 12098 |
| Settle / open next series | 1235851 | 1235851 | 1235851 |

**The 70k target is met for measured steady batches and a new-worker batch, with hard regression assertions.**
It is NOT a universal per-header cap: the first single header initializes worker/epoch records, and the first
24-header batch crossing a retarget measures 71748. Reorg rewrites and small batches may cost more.
The 2028-real-header differential test also enforces an aggregate <=70k/header including its epoch transitions.
The comparable first reward batch is 42.76% cheaper than T1 and 28.69% cheaper than the initial T2.
Reward-fold overhead is reported rather than hidden in the submit benchmark.

## Tests and review focus

- All 2028 real fixture headers compared against the frozen T1 relay: every hash, height, timestamp,
  cumulative work and submitter. Original JS/Solidity R/S tests remain unchanged.
- Original vault invariants, fee conservation, claim accounting, shallow/deep/shorter-heavier fork tests retained.
- New fuzz tests prove full parent-hash and ID round trips; inputs with nonzero discarded bits revert.
- Alternating submitters, duplicate headers, orphan promotion and finalized reward ownership checked.
- uint128 work and uint32 height limits remain explicit. Node/worker/epoch ID capacity rejects before aliasing
  existing records. Parent/height/work/epoch comparisons never use a truncated unchecked value.
- Synthetic easy-PoW fork tests need a TEST-ONLY full-parent mapping: their artificial hashes do not satisfy
  mainnet's 224-bit PoW bound. Production packing is exercised by the real fixture, encoding fuzz tests and
  the shorter/heavier synthetic-SHA test. No easy-target or alternate-parent switch is deployed.
- The vault, index, reward distributor/router and original vault invariant file are unchanged from T1.

The representations worth independent review are lossless parent-hash reconstruction, half-word metadata
isolation and epoch-based work across retargets/forks. More compact storage increases representation complexity;
it does not remove the existing SPV/checkpoint/deep-reorg limitations. Runtime size: 6825 bytes, below EIP-170.

## Delivery

Validation on 2026-09-20: 78 Solidity test results passed across 9 suites (0 failed / skipped), including
both invariant groups at 64 runs × 60 calls. The 2028-header aggregate measured 68098 gas/header.
All 3 Node Bitcoin-vector/adapter tests passed. `forge build --sizes` passed; the runtime size above is for
the production relay. The final source/tests were included in the concurrent review commit `7f48f2a`.

The review in that commit superseded T1's lifetime-points/burn economics while the testnet deploy script
was running. The script was stopped and was NOT resumed, but independent RPC receipt checks confirm all
12 transactions had already succeeded. These are testnet-only contracts; they have NOT been selected for
the terminal or keeper. No live header/fold gas claim is made for this unused deployment.

- Confirmed relay: `0x447ecac913985e82e07f20d3a9feb0a31478726e` (BSC testnet, chain 97).
- Confirmed index: `0x1214e23402de7502f575d881dad61143533f16a1`.
- All addresses/transaction receipts: [unused deployment record](../../contracts/deployments/t2-interrupted-deployment.json).
- The active T1 manifest remains `contracts/deployments/bsc-testnet.json`; its snapshot is
  `contracts/deployments/bsc-testnet-rewards-v1.json`. Port 8790 remains that comparison deployment.
- T0 claims correction and T1 operations-reserve rework now take priority. Reuse the packing, then remeasure
  integrated gas after the replacement bounty mechanism and T2b header checks. No mainnet deployment.
No Git remote is configured, so a PR cannot yet be opened.
