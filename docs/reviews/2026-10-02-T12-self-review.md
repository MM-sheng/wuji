# Self-review: the open questions of the T12 review handoff

Author: the T12 session itself, 2026-10-02, working through §3 of
[REVIEW_HANDOFF.md](../tasks/REVIEW_HANDOFF.md). **Not an independent review**; it is here so an
independent reviewer can start from the numbers and check them. Source before fixes: `2904b9e`.

## 1. Disputing honest batches paid (fixed → WUJI-13)

Backing costs ≈ 600k + 19.5k gas per header (measured: 1,193,343 for 60, 1,915,880 for 100). A full batch of
250 headers is ≈ 5.5M gas: 0.055 ETH at 10 gwei, 0.16 ETH at 30 gwei, against a 0.05 ETH bond. Whenever
backing costs more than the bond, a rational third party does not back; the batch is rejected after `R`, and
`reject` returned the bond **and** paid the disputer the batch's relayer bounty. Disputing every honest batch
was therefore free, paid, and stopped the index for `W + R` per round.

Fix: the bounty is paid only by `refute`, where real headers show the batch differs. `reject` (unbacked, not
shown false) returns bonds and pays nothing. Tests: `test_aRefutedBatchPaysItsBountyToTheDisputer`,
`test_aRejectedBatchPaysNoBounty`.

Still open: a griefer who does not mind losing nothing can still delay honest batches by `W + R` whenever
backing is unprofitable for everyone but the prover. The prover backs its own batch to keep its bounty; a
bond that scales with batch size, or smaller batches at high gas, would remove the gap. Mainnet question.

## 2. B could be priced from a hand-picked stale header (fixed → WUJI-14)

B priced at `supplied tip + DELAY (16)` and accepted the supplied tip if its timestamp was ≤ 30 min old. Bitcoin
accepts timestamps up to 2 h ahead, and the **requester chooses where the supplied chain stops**. Stopping at a
recent block stamped ≈ 2 h ahead, at the moment it looks 30 min old, its real age is ≈ 2.5 h: ≈ 15 blocks have
followed it, and the pricing height (16–21 ahead) already exists with probability ≈ 0.07–0.43 (Poisson). Rare
timestamps, but a selection the requester gets for free, three to six orders of magnitude off the 1e-7 target.
A relay's best header (C) has the same residual only if the requester mines it.

Fix: B uses A's margin table (which includes 2 h of skew and a 1.25× rate) on the supplied tip's own age:
`supplied tip + marginForAge(its timestamp)`. A fresh supplied tip now waits ≈ 7 h instead of 3–4 h, still about
half of A's 12–15 h. A supplied header more than 2 h in the future is already refused by the index
(`FutureTime`). Tests: `test_BPricesFromSuppliedHeadersWithTheMarginForTheirAge`,
`test_BMarginCoversAStoppingHeaderStampedInTheFuture`.

## 3. Reject-reward drain without watchers

Moot after §1: `reject` pays no bounty.

## 4. A's model

A finalized tip stamped in the future looks younger by ≤ 2 h, covered by the skew term once; stamped in the
past it looks older and gets a larger margin (safe). 1.25× covers sustained hash-rate growth between retargets
(historically ≈ 1.05–1.1×). No change.

## 5. Sorted pending-epoch queue

Distinct pending epochs are bounded by the pricing horizon: at most ≈ (273 + 16) / EPOCH ≈ 50, so an insertion
shifts at most ≈ 50 entries (≈ 1M gas worst case, paid by that requester). Dust requests cannot create epochs
beyond the horizon. No change.

## 6. WUJI-09, no reorg view on ZK pools

Unchanged; recorded.

## Effect on deployments

Both fixes change contract code. The Sepolia `ZkWujiIndex` (`0x0350ff37…`) and the T11 pools on it keep the old
behaviour until redeployed.
