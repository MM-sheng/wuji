# Decision proposal: the header path as the mainnet primary, ZK kept as an option

Status: **proposed** by the project owner, 2026-10-02. For the development session to evaluate (numbers,
contract consequences, migration) and either execute or answer with reasons. Written by the documentation
session; no code changed.

## The question

Since the gas correction (`1860f96`), the comparison that matters is not the ZK path against the storage-backed
`BitcoinRelay` (~90k gas per header) but against `ZkWujiIndex.foldHeaders`, which checks the same rules without
storing headers (~19k gas per header). Is the remaining saving worth what the ZK path costs in trust, hardware,
latency and complexity?

## Numbers (all measured in this repository)

| path | measured | per day (144 heights) | per 30 days |
|---|---|---:|---:|
| `foldHeaders` | 1,915,880 gas / 100 headers (anvil, `T12_CHALLENGE_WINDOW.md`) | ≈ 2.8M gas | ≈ 83M gas |
| `foldProof` + `finalize`, max batch | 459,162 + 112,056 gas / 244 heights (Sepolia) | ≈ 0.34M gas | ≈ 10M gas |
| `foldProof` + `finalize`, 42-header batches (current keeper default) | ≈ 324k + 112k / 36 heights | ≈ 1.7M gas | ≈ 52M gas |

The header-path figure should add ≈6 trailing confirmation headers per call (≈4% for one call a day).

In money, assuming ETH = USD 3,000 (illustration only):

| gas price | `foldHeaders` / month | ZK, max batch / month | difference |
|---|---:|---:|---:|
| 0.3 gwei | ≈ USD 75 | ≈ USD 9 | ≈ USD 66 |
| 1 gwei | ≈ USD 250 | ≈ USD 30 | ≈ USD 220 |
| 5 gwei | ≈ USD 1,250 | ≈ USD 150 | ≈ USD 1,100 |

## What the ZK path costs besides gas

1. **Trust in SP1**: proof system, implementation and verifier contract (three published soundness advisories:
   v3 early 2025, pre-4.0.0 Jan 2025, 6.0.0–6.0.2 Apr 2026), and a Groth16 circuit-specific setup whose phase 2
   was contributed by the SP1 team.
2. **Immutable binding**: a flaw found later in the pinned verifier cannot be patched, only migrated away from.
3. **Hardware**: ≈31 GB of memory per proof, so a keeper needs a large machine or a paid proving service.
4. **Latency**: batch time plus the challenge window before consumers see a new `S`.
5. **Complexity**: pending queue, disputes, bonds, `back`/`reject`/`refute`, a watcher, and their review
   surface (WUJI-08 and WUJI-12 were both found in this layer within a day).

The header path has none of these: it trusts the EVM and a few hundred readable lines, runs on a small server,
and finalizes about an hour after a block.

## Proposal

1. **Mainnet primary**: deploy `ZkWujiIndex` **header-path-only** (`verifier = address(0)`, which the constructor
   already supports and which makes `foldProof` revert). No challenge parameters, no watcher needed for safety.
   Keepers call `foldHeaders` about once a day (or as gas allows).
2. **Keep the ZK work**: code, tests, the Sepolia deployments and the keeper stay as a measured, documented
   option. Turning it on later means a new deployment with a verifier and the T12 window, and migrating
   consumers, because contracts are immutable. Revisit when gas or volume makes the difference material
   (for example sustained > 5 gwei, or many consumers sharing the cost).
3. **Grant story**: "We built and verified the ZK path on a public testnet; mainnet starts on the path with the
   fewest trust assumptions and keeps ZK for when scale justifies it." The proposal's cost claims move from
   "ZK makes it affordable" to "the header path is affordable; ZK cuts it further by about 8x at full batches".

## Questions for the development session

1. Do the per-day numbers hold on Sepolia for one `foldHeaders` call a day of ≈150 headers (gas per header at
   that batch size, and the 512-header cap)?
2. Does anything in T11-on-ZK (`seenTip`, marking from headers, pricing by finalized tip + margin) assume the
   proof path or the challenge window? Pricing latency should improve (≈1 h instead of batch + window).
3. Is a header-path-only `ZkWujiIndex` the right contract, or should the mainnet primary be the older
   `WujiIndex` + `BitcoinRelay` pair (frozen exit, relay history) despite ≈90k gas per header?
4. Which documents change (README intro, T10/T12 status, THREAT_MODEL, GRANT_PROPOSAL, the ethresear.ch draft)?
   The documentation session can update the proposal and the post once this is decided.

## Response from the development session (2026-10-02)

**Agree with the direction (header path as the mainnet primary, ZK kept as an option), with one blocker:
the header-path-only `ZkWujiIndex` has no deep-reorg rule, so it is not mainnet-ready as it stands.**

### 1. Gas per day — confirmed

Measured on anvil (prague), real mainnet headers, a header-path-only `ZkWujiIndex`, transaction gas including
intrinsic and calldata:

| headers per call | heights folded | tx gas | per folded height |
|---:|---:|---:|---:|
| 42 | 36 | 852,586 | 23,683 |
| 156 | 150 | 2,964,105 | 19,761 |
| 256 | 250 | 4,818,381 | 19,274 |
| 512 (cap) | 506 | 9,574,342 | 18,922 |

Linear fit ≈ 75k + 18.55k per header. One call a day of ≈ 150 heights is ≈ 2.96M gas, matching the estimate
(2.8M + ≈ 4%). The 512-header cap (≈ 9.6M gas, inside the 16.7M EIP-7825 cap) covers ≈ 3.5 days of catch-up per
call. Folding every 6 h (42 headers) costs ≈ 3.4M gas a day, +15%.

### 2. T11 on this index — no dependency on proofs, but fold frequency sets the wait

`seenTip`, `markWithHeaders`, tip marking and pricing A/B use only the finalized state, which `foldHeaders`
maintains; nothing needs `foldProof` or the challenge window (a header-only deployment takes a zero
`Challenge` and has no queue). But "≈ 1 h latency" holds only right after a fold. A prices from the finalized
tip's *age*: with one fold a day that age runs from ≈ 1 h to ≈ 25 h, so A waits ≈ 7–21 h and refuses requests
once the tip passes 24 h (any late keeper). B (supplied headers, after WUJI-14) is ≈ 7 h regardless.
Recommendation if pools run on it: fold every ≈ 6 h (+15% gas), giving A ≈ 7.7–12 h.

### 3. Which contract — `ZkWujiIndex` header-only, **after adding a deep-reorg rule**

The decisive difference is not gas. `ZkWujiIndex` keeps only its finalized tip. If Bitcoin reorganizes deeper
than `CONFIRMATIONS` (6) past that tip, real headers never link to it again: `foldHeaders`, `seenTip` and
every pool on it stop forever, and nothing can freeze or exit (`frozen()` does not exist; pools on it have
`INDEX_CAN_FREEZE = false`, so open T11 accounts would be locked). `WujiIndex` + `BitcoinRelay` has the T9
frozen exit, which the queue marks "required before mainnet" (NEXT.md §T9).

Options, in the order I would take them:
1. **Add a T9-equivalent to `ZkWujiIndex`**: accept a reorg proof — a valid branch forking below the finalized
   tip with more work than the finalized chain up to its confirmations — and freeze at the last consistent S,
   with pools and vaults exiting as under T9. Needs design and review, but keeps ≈ 19k gas per height.
2. `WujiIndex` + `BitcoinRelay` as is: frozen exit and relay history today, ≈ 90k gas per header
   (≈ 4.7× the header path: ≈ 13M gas a day, ≈ USD 1,200 a month at 1 gwei / USD 3,000).
3. Header-only `ZkWujiIndex` without a reorg rule: cheapest, but a > 6-deep reorg locks consumers' funds.
   Not acceptable for vaults or pools holding value.

Deep reorgs are rare (the last > 6-deep on mainnet was 2013), but the exit is what makes "no admin key" safe
when they happen.

### 4. Documents that change once decided

README intro (mainnet path), T10_DESIGN and T12 (status: ZK is the measured option, not the mainnet plan),
ARCHITECTURE 决定记录, THREAT_MODEL (succinct-proof section becomes conditional; add the header-only reorg
rule or its absence), MAINNET_CHECKLIST (which index, fold cadence), GRANT_PROPOSAL and the ethresear.ch
draft (documentation session), T11 (fold cadence vs A's wait), and NEXT.md (a new task for the reorg rule).
The development session will take the contract-side ones; the proposal and post stay with the documentation
session.

### Side effect on pending work

If mainnet is header-only, redeploying the Sepolia ZK index for WUJI-13 matters less (it is ZK-only); WUJI-14
(B pricing) applies to any relay-less pool and should ship with whatever index the pools move to.

## Owner decision (2026-10-02)

**ZK is not part of the mainnet plan.**

- **Mainnet:** header path only (`foldHeaders`-style folding), with a deep-reorg freeze rule added first, as the
  development session's response requires. No verifier, no challenge window, no watcher needed for safety.
- **Testnet, transitional only:** the Sepolia ZK keeper keeps running until a header-only index with the reorg
  rule is live on Sepolia; then the ZK keeper stops and the ZK deployments are left as historical records.
- **Code:** T10 (SP1 guest, verifier path) and T12 (challenge window, watcher) stay in the repository as
  measured research results. No further development or maintenance effort on them.
- **Next development task:** the deep-reorg rule for the header-only index (option 1 in the response above),
  then its Sepolia deployment, T11 pools moved onto it, fold cadence ≈ every 6 h.
- **Documentation session:** rewrite the grant proposal and the ethresear.ch draft around the header path
  ("ZK was built, measured on a public testnet and deliberately not adopted for mainnet; here is why"), once
  the development session confirms the reorg-rule plan.
