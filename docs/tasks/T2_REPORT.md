# T2 — bounded relay storage packing

Branch `codex/relay-packing`, based on T1 commit `143592b`. This is a local code/test change; the
running testnet contracts remain the T1 release and cannot be upgraded in place.

## Changes

- Node shrinks from three storage slots to two: full parent hash, then uint128 work + four uint32 fields
  (height, timestamp, bits, epoch timestamp). Nonzero work replaces the redundant known flag.
- The task's proposed additional bool would require a third slot: 128 + 4×32 already fills 256 bits.
- Constructor and insertion explicitly reject height > uint32.max and work > uint128.max. Addition is
  performed in wider types BEFORE checking and narrowing; overflow never silently changes fork choice.
- Hash byte reversal uses fixed byte-lane swaps instead of a 32-iteration loop. Fuzz tests compare it to
  the reference loop and check that reversing twice restores the original word.
- PoW, retarget calculation, parent/batch links, cumulative-work fork choice, canonical mapping,
  submitter attribution and finality/reward behavior are unchanged within the supported numeric range.

## Controlled gas comparison

Same Solidity 0.8.28, optimizer 200, same fixtures, test functions, batch boundaries and rewards mode.
Measurements are test-body execution gas, excluding transaction intrinsic/calldata gas.

| Operation | T1 baseline 143592b | T2 |
|---|---:|---:|
| Cold first header at retarget, rewards disabled | 165589 | 138941 |
| Following batch of 24, per header, rewards disabled | 125233 | 100500 |
| Batch of 24 including first retarget, rewards enabled | 125345 | 100612 |
| Fold per height, rewards enabled, 16 heights | 100712 | 100712 |
| Fold per height, rewards disabled, 19 heights | 12098 | 12098 |
| Settle/create next series | 1235851 | 1235851 |

The reward-enabled batch improves by **19.73%**. **The <=70000/header target is NOT met.**
NEXT.md's 103k starting figure predates T1's per-header submitter attribution. After packing, each normal
new header still creates four distinct storage slots (parent, packed metadata, canonical hash, submitter).
Even the four zero-to-nonzero writes alone cost 80000 gas under this layout, before access and validation
costs. Node packing alone therefore cannot reach 70000 with the current T1 attribution representation.
A further reduction requires changing the storage representation of attribution or another per-header
record, with bounded reconstruction and fork/reward correctness tests. This change does not hide reward
costs by turning rewards off or drop validation to satisfy the headline target.

## Verification

- Frozen relay implementation from 143592b committed under test/reference, never used for deployment.
- Differential test submits all 2028 real mainnet headers to both versions, comparing every canonical hash,
  work total, height, timestamp and submitter; both epoch transitions are exercised.
- Existing JS/Solidity R and S tests retain their real-header vectors and known-height 800000 byte order.
- Overflow tests cover constructor bounds and subsequent height/work addition, checking atomic rejection.
- Existing shallow/deep/shorter-heavier fork and reward attribution tests remain enabled.
- Vault, index, reward distributor and original vault-invariant files are byte-for-byte unchanged from T1.

Final validation: full Foundry suite passed (73 reported test entries, including grouped original
vault invariants); both invariant groups ran 64 × 60 calls with zero reverts. All three Bitcoin Node
tests passed. Compiler storage layout reports exactly 64 bytes for Node, with work/height/time/bits/epochTime
at byte offsets 0/16/20/24/28 in its second slot. Relay runtime is 5489 bytes (T1: 5047), below EIP-170.

## Limits / next decision

uint128 is a deliberate storage bound, not a theorem that Bitcoin work can never exceed it. Such a future
header is rejected rather than mis-accounted. No migration or administrator recovery is introduced.
Numeric bounds and remaining SPV limitations must remain part of release review.

No new testnet deployment or PR is claimed here. The existing runtime at 8790 still corresponds to the
recorded T1 manifest. No Git remote is configured. Further gas work and review remain open.
