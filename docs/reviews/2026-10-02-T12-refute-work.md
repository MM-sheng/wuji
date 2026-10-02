# Review note: `refute` does not compare work (T12, ZkWujiIndex)

Reviewer: Claude (separate session, read-only review), 2026-10-02. Source at `597f07c`. For the session that
owns T12 to accept, change or reject. No code was changed by this review.

## Finding

`refute(id, headers, tokens)` succeeds when the replayed branch reaches **any different** end state
(`!_matches`). It does not compare the replayed branch's cumulative work with the batch's claimed `toWork`.

Consequence for an **honest** batch: anyone can `dispute` it (bond refunded by `_reject`), then `refute` it with
a different branch that satisfies the header rules and has `CONFIRMATIONS` descendants, even if that branch
has less work than the canonical chain the batch proved. If the batch is the oldest pending one, the
lighter branch is then folded as the finalized state (`_commitReplay`).

Cost to the attacker: privately mining from a fork point inside or at the end of the batch through
`CONFIRMATIONS` more blocks at the real difficulty, at least 7 blocks. That is the same bar `foldHeaders`
already accepts (documented: "any branch with valid proof of work and CONFIRMATIONS descendants"), so this is
not a new class of trust. But here a competing claim with known work is on chain, and ignoring it gives up
heaviest-chain fork choice exactly where it is available.

Severity suggestion: Medium for mainnet (index consumers such as T11 pools could be settled on an attacker's
branch at the cost of ≈7 private blocks), Low on testnets.

## Suggested fix

In `refute`, additionally require `w.committedWork > b.toWork` (strictly heavier at the same height).

- Honest batches on the canonical chain can then only be replaced by a branch that out-works the network.
- Forged batches (broken proof system) that claim a **normal** work value are still refuted at once.
- Forged batches that also inflate `toWork` can no longer be refuted at once; they fall back to `reject`
  after `RESPONSE_WINDOW`, since they can never be backed. This reopens WUJI-08's liveness concern only for
  that sub-case (broken prover **and** inflated work), bounded to one `W + R` delay per forged batch.

Alternatives if that trade-off is unwanted: bound the claimed work by recomputing it from the claimed bits
when no retarget falls inside the batch (`toWork == fromWork + n·workOf(bits)`), so inflated work is itself
rejected at `foldProof`; or keep the current rule and document the ≈7-block cost explicitly in
`THREAT_MODEL.md` and T12.

## Tests to add

1. Honest batch on chain A; a valid lighter branch B of equal length from the same start: `refute` with B
   must revert (after the fix) and `back` with A must succeed.
2. Forged batch with normal work: `refute` with the real headers succeeds at once (as today).
3. Forged batch with inflated `toWork`: `refute` reverts, `reject` after `RESPONSE_WINDOW` removes it, and the
   header path then advances.

## Checked and fine

- `MAX_PROOF_HEADERS` (250) + `CONFIRMATIONS` ≤ `MAX_HEADERS` (512): every proposed batch can be backed in one
  transaction.
- `withdraw` zeroes `owed` before the call; bonds of later removed batches are refunded in `_reject`.
- `finalize` applies backed batches before `finalAt`, and stops at the first not-ready batch.
- Reward tokens are fixed at proposal/dispute time and validated with RelayerRewards' rule, so `finalize` and
  `reject` cannot be made to revert by the caller's token choice; `award` failures are caught in `_reject`.
- `seenTip` validates from the finalized tip with every header rule and writes nothing.
