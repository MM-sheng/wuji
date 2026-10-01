# T12 design: a challenge window for ZK folds

Status: implemented 2026-10-01 and deployed on Sepolia the same day
(`0x0ee930Fe689a29Fde478a5fE995e17AE0Fd06B47`, `contracts/deployments/sepolia-zk-t12.json`); not audited. Applies to `ZkWujiIndex` (T10). Implementation notes and measurements are at the end.

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
6. `refute(i, headers)` (anyone, any time while `i` is disputed and unbacked; added after review, WUJI-08)
   does the same at once when the real headers over the batch's range replay to a *different* state, and for
   the oldest batch folds that real state, so forged proofs at the head of the queue cannot hold the index.

The raw-header path (`foldHeaders`) stays available, but only from the last *finalized* state and only when no
batch is pending, so it cannot race a dispute.

## Parameters (proposed)

| name | value | reasoning |
|---|---|---|
| `W` challenge window | 6 hours | Watchers need to be online a few times a day, not continuously; S consumers already wait 3–4 h (T11) |
| `R` response window | 6 hours | Enough to fetch and submit headers during an Ethereum gas spike |
| `B` dispute bond | 0.05 ETH: pays a full 250-header backing (≈ 5M gas) at 10 gwei | A wrong dispute costs the disputer the backing gas, so griefing is not free |
| batch cap | 250 headers, folded + confirmations | Backing must fit in one transaction: measured ≈ 20k gas per header, ≈ 5M gas at the cap |
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

## Implementation (2026-10-01)

`contracts/src/ZkWujiIndex.sol`, `contracts/src/RelayerRewards.sol` (`award`), `indexer/zk-watcher.mjs`,
`indexer/zk-challenge.mjs`; `indexer/zk-keeper.mjs` finalizes and caps its batches.

Where the build differs from, or fills in, the design above:

- **Batch cap** is `MAX_PROOF_HEADERS = 250` headers *including* the 6 confirmations (244 folded heights).
  The design's "≈ 99k gas per header" came from a test that measured its own byte-copy loop together with
  the contract; measured correctly, the Solidity rules cost ≈ 19–20k gas per header (`back` with 60 headers:
  1,193,343 gas; 100 headers on anvil: 1,915,880).
- **Checkpoint heights are the contract's.** `foldProof` requires the journal's checkpoint heights to be exactly
  the series boundaries in `(from, to]` (the guest's rule `(h + 1 − genesis) % interval == 0`), so a proof is
  trusted only for the U values there. `back` compares those values with the replay.
- **Token lists are fixed at submission.** The prover's relayer-bounty tokens are stored with the batch and
  the disputer's with the dispute, both validated (≤ 8, sorted, unique) up front. Whoever calls `finalize`
  or `reject` cannot choose them, and a stored list can never make either revert.
- **Reject reward:** `RelayerRewards.award` (index-only) pays the disputer the bounty the batch would have
  earned, consuming no heights. `reject` calls it in `try/catch`: the reward must never keep a forged batch
  queued. A griefer who proves an honest batch, disputes it and finds nobody backing it within `R` collects
  this reward; that requires every watcher to be offline for `R`, and is bounded by one batch's bounty per
  `W + R`.
- **Queue cap** `MAX_PENDING = 32`, so `reject` can always delete the tail it invalidates in one transaction.
- **Payments are pulled:** bonds go to `owed[...]`, withdrawn with `withdraw()`.
- `continuity()` now returns the head a prover must extend (newest pending batch, else finalized);
  `stateBefore(id)` returns the start of batch `id`. `tip`, `S()`, `lastHeight()` stay finalized-only.
- `foldHeaders` records checkpoints with the same boundary rule; the `nextCheckpointHeight` storage
  variable is gone (nothing read it).
- Windows and bond are constructor parameters (`Challenge{window, responseWindow, bond}`), required
  non-zero when a verifier is set. `DeployZkIndex.s.sol` defaults to 6 h / 6 h / 0.05 ETH and can reuse the
  deployed SP1 verifier (`SP1_VERIFIER`).

### Watcher

`indexer/zk-watcher.mjs` replays each pending batch from its starting state over headers from the first
source, cross-checks the header at the claimed height with a second source (`WATCH_SOURCES`, default
`p2p,http`; it does nothing when they disagree), and compares every field. Mismatch inside the window →
dispute; disputed and matching → back; disputed, unbacked, past `R` → reject; ready → finalize.
`WATCH_DRY_RUN=1` only logs. The JavaScript replay reproduces the Rust guest's journals exactly
(`zk-challenge.test.mjs`).

### Tests and measurements

- Foundry: `ZkWujiChallenge.t.sol` (20 tests: pending/finalize, chaining, header path blocked while
  pending, caps, boundary rule, dispute/back/reject rules, cascading reject, bounties on finalize and
  reject) and `ZkWujiChallenge.invariant.t.sol` (32 runs × 300 calls, a verifier that accepts anything, an
  honest watcher, random griefers): the finalized state is always the real chain, bonds are conserved
  (`balance == owed + open bonds`), an honest disputed batch can always be backed, the queue stays bounded.
  Full suite: 203 Foundry tests green; Node 85 pass, 1 skipped (needs a synced P2P header file).
- Node: `zk-challenge.test.mjs` (9 tests) and `zk-keeper.test.mjs`.
- End to end on anvil against the compiled contract: forged batch → watcher disputes → rejects after `R`,
  S unchanged; honest batch griefed → watcher backs with 100 headers → finalizes; watcher owed both bonds.
- Gas, 100 real headers with SP1's Groth16 verifier: `foldProof` 589,259 + `finalize` 135,574 = 724,833
  (T10 without the window: 453,888). The header path for the same headers: **1,928,070**, not the
  7,956,964 first reported in T10 (same measurement error as above; corrected in README, T10 design,
  grant proposal, related work and the ethresear.ch draft).

### Sepolia (2026-10-01)

- Deployed from `e9b1c21` with the T10 anchor (969131) and SP1's v6.1.0 verifier reused; 4,319,178 gas,
  tx `0x7f2d3a3293f0a0ea5d8c90700491cc083d87abf13644f92986b16dea8525183b`. Runtime bytecode equals the local
  build with immutables masked; every binding read back.
- The ZK keeper moved here from the T10 contract (which stays at 969347 as a comparison). First batch: 250
  live headers 969132–969381 proved in 294 s; `foldProof` 459,162 gas, tx
  `0x8be19702b22053ac7eac499a2d114a0373c6bec90cd21ee59c64147fca37404b`, pending until 09:11 UTC.
- The watcher runs as the deployer account with P2P + mempool.space and reported batch 0 as matching the
  chain within two minutes of submission.

### After deployment: WUJI-08

Reviewing the deployed contract found that, with a broken verifier, an attacker keeping one forged batch at
the head of the queue (one proof per `W + R`) would block honest proofs and the header path indefinitely.
Fixed in source with `refute` (step 6 above; `docs/AUDIT_NOTES.md` WUJI-08). The watcher refutes right after
disputing and falls back to `reject` on contracts without `refute`, such as the one deployed above. The fix
needs a redeployment to take effect on Sepolia.

### Not done

- Record the first finalization; run a second watcher on another machine.
- Redeploy with `refute` (WUJI-08).
- Independent review of the queue and dispute paths.
