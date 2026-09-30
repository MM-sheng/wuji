# T12 design: a challenge window for ZK folds

Status: design, 2026-10-01. Not implemented. Applies to `ZkWujiIndex` (T10).

## Why

Today a valid SP1 proof moves the index immediately. If SP1's proof system, its Groth16 setup or its verifier
contract is ever broken (SP1 has published three soundness advisories: v3 in early 2025, pre-4.0.0 in January
2025, 6.0.0–6.0.2 in April 2026), a forged proof could move the index to any state, and the immutable contract
could not be patched. The goal is that a forgery succeeds only if **SP1 is broken and nobody honest objects in
time**, while the normal path stays as cheap as today.

## The rule in one paragraph

A proof no longer changes the index directly: it opens a *pending batch*. The batch becomes final after a
window `W` unless someone disputes it. A dispute costs a bond. After a dispute, the batch is kept only if
someone posts the raw Bitcoin headers of the batch (plus the confirmation headers) and the contract checks
them with the Solidity rules it already has (`foldHeaders`) and finds exactly the claimed result. Real headers
are public, so an honest batch can always be backed; a forged batch has no valid headers behind it and is
rejected. The disputer's bond pays for the backing if the dispute was wrong.

## Why "compare work" is not enough

The obvious alternative, "a challenger posts a heavier real chain", fails exactly when it matters: if SP1 is
broken, the forged journal can also claim an arbitrarily large `newWork`, and no real chain beats it. Asking
for the claimed headers themselves removes that escape: the contract never has to trust a claimed number.

## State and flow

```
struct Pending { Continuity from; Continuity to; uint32[11] toTimes; uint256 toWork;
                 uint64[] checkpointHeights; int64[] checkpointU;
                 uint64 finalAt; address disputer; uint64 respondBy; }
```

1. `foldProof` verifies the proof exactly as today, then appends a `Pending` whose `from` must equal the last
   finalized state or the previous pending batch's `to` (batches chain). Nothing that consumers read changes.
2. `finalize()` (anyone) applies the oldest pending batch once `block.timestamp ≥ finalAt` and it is not
   disputed: state, checkpoints and relayer bounties exactly as `foldProof` applies them today.
3. `dispute(i)` (anyone, before `finalAt`, with bond `B`) marks batch `i` disputed and sets `respondBy = now + R`.
   Later pending batches wait behind it.
4. `back(i, headers)` (anyone, before `respondBy`) runs the existing Solidity header rules from `from` over the
   batch headers and the `CONFIRMATIONS` headers after them. If the result equals `to` (hash, height, bits,
   time, epoch start, times, work, U and checkpoints), the batch is final at once and the bond goes to the
   caller of `back`. Otherwise it reverts.
5. `reject(i)` (anyone, after `respondBy` with no successful `back`) deletes batch `i` and every pending batch
   after it, and returns the bond to the disputer plus a reward.

The raw-header path (`foldHeaders`) stays available, but only from the last *finalized* state and only when no
batch is pending, so it cannot race a dispute.

## Parameters (proposed)

| name | value | reasoning |
|---|---|---|
| `W` challenge window | 6 hours | Watchers need to be online a few times a day, not continuously; S consumers already wait 3–4 h (T11) |
| `R` response window | 6 hours | Enough to fetch and submit headers during an Ethereum gas spike |
| `B` dispute bond | enough to pay backing at 10 gwei (≈ 0.05 ETH for 42+6 headers) | A wrong dispute costs the disputer the backing gas, so griefing is not free |
| batch cap | 250 headers | Backing must fit in one transaction: ≈ 99k gas × (250 + 6) ≈ 25M gas |
| reward on `reject` | a share of the relayer reserve | Watching has to pay something, however little |

## What changes for consumers

- `S()`, `lastHeight()`, checkpoints and relayer bounties reflect **finalized** batches only, `W` later than
  today. T11 pools priced from this index see prices up to 6 hours later than the proof.
- New view: `pendingCount()`, `pending(i)`, so front ends can show "proved, finalizing at …".

## Security, stated plainly

| SP1 sound? | Honest watcher online within `W`? | Outcome |
|---|---|---|
| yes | any | Only true batches can be proved; nothing to dispute |
| no | yes | Forged batch disputed, cannot be backed, rejected |
| no | no | Forged batch finalizes after `W`: **loss possible** |

Other costs: finality is `W` later; watchers must run a Bitcoin header source and compare the pending `to.hash`
with the real header at that height (the existing indexer already computes it); honest batches can be delayed
by `W + R` by anyone willing to lose a bond each time; the contract grows by roughly the pending queue and the
dispute paths, all of which need audit.

## Watcher

`indexer/zk-watcher.mjs`: every few minutes read pending batches, fetch the header at each `to.height` from
two independent Bitcoin sources, dispute on mismatch, and back any disputed batch whose headers it can
produce (so a griefer's bond pays the honest keeper). The project runs it on at least two machines and says
so; anyone else can run the same script.

## Build order

1. Pending queue + `finalize` + consumer views; existing tests adapted (state only moves on finalize).
2. `dispute` / `back` / `reject` with bond accounting; invariant tests: a forged journal accepted by a mock
   verifier never finalizes when disputed; an honest batch always can be backed; bonds are conserved.
3. Watcher script, then Sepolia deployment beside the current `ZkWujiIndex` (a new address: the deployed
   contract is immutable).
