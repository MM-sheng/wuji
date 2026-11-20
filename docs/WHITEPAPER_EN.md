# WUJI · 无极

## A Bitcoin Proof-of-Work Index Verified on Ethereum, and Bounded Claims Settled Against It

Technical Whitepaper · Version 1.0 · 20 November 2026

Contract source described: `main` at commit `4d63357` · Public testnet deployment: Ethereum Sepolia, built from commit `03f6256`

> **Status.** WUJI runs on public testnets only. Its contracts have not been independently audited. This document
> is a technical specification and analysis, not an offer of any asset, a solicitation, or investment advice. Where
> this text and the contract source disagree, the source at the stated commit is normative. Every number in this
> paper is either a contract constant (with its source file), a measurement (with its record), or the output of a
> stated mathematical model; the three kinds are labelled and never mixed.

---

## Abstract

WUJI maps the sequence of Bitcoin block headers to a public integer random walk that anyone can recompute from
Bitcoin alone, and verifies that mapping inside an immutable Ethereum contract without trusting any operator.
For each Bitcoin height `h` the protocol takes the raw header digest `H_h`, hashes it once more,
`R_h = SHA256(H_h)`, and adds the centred byte sum `d_h = Σ bytes(R_h) − 4080` to an accumulator `U`.
The index is `S = 1.2·10⁻⁵ · U`.

The verifying contract, `WujiHeaderIndex`, accepts raw 80-byte headers from anyone and enforces three rules.
(1) Each header must satisfy Bitcoin's header consensus checks: proof of work against the encoded target, hash
linkage, the 2016-block retarget with its ×4 clamp, median-time-past, a two-hour future bound, and the buried
BIP34/66/65 version floors. (2) A height enters `S` only once 100 valid headers follow it. (3) A valid branch
that forks below the finalized tip and out-works the finalized chain by `100 + 144` blocks permanently seals the
index at its last consistent state. Submitters are paid per finalized height from an immutable operations
reserve. Nothing can be changed after deployment: there is no owner, administrator, pause, upgrade path,
governance process, or project token.

On top of the index, WUJI specifies perpetual two-sided accounts with fixed principal and bounded, additive
profit and loss. Each entry and exit is priced at a Bitcoin height that, under a stated Poisson model, was
unmined when it was requested, with probability at least 1 − 10⁻⁷. Losses in these accounts are allocated
deterministically, so the order in which people claim cannot change what anyone receives. Exposure is capped
per pool, and the cap halves with each Bitcoin subsidy halving. Under the random-oracle model this makes block
withholding unprofitable in expectation for any miner whose exposure comes only from the pools.

This paper defines each component precisely and states its properties as propositions with their assumptions.
It separates what is enforced by code from what depends on economics or operations, and lists the evidence
that exists and the evidence that does not.

---

## Contents

1. Introduction
2. Design constraints and trust model
3. Notation and conventions
4. The index
5. Verifying Bitcoin headers on Ethereum
6. Operations reserve and submitter incentives
7. Perpetual accounts
8. Reference application: fixed-term paired claims
9. Security analysis
10. Mathematical limits: what the index does not promise
11. Implementation, verification and evidence
12. Deployment status and open gates
13. Related work
14. Conclusion

Appendices: A. Parameters · B. Test vector · C. Pricing-margin table · D. Reproduction · E. Glossary

<!-- pagebreak -->

## 1. Introduction

### 1.1 Problem

Every financial benchmark has an author. A price index is computed by an exchange or an index provider. A
random-number market is driven by an operator's generator. An oracle feed is published by a committee. Users of
the benchmark must trust that the author computed it honestly, and they usually cannot recompute it themselves.

WUJI asks a narrower question. Can a public reference path exist that (a) no party quotes or controls, (b)
takes no market price as an input, (c) anyone can recompute from public data with a few lines of code, and (d)
an immutable smart contract can verify on its own, so that claims can settle against it without an oracle?

Bitcoin proof of work offers such a source. Its headers are public, scarce (each costs real work), ordered, and
self-authenticating. WUJI turns them into an index and builds the minimum machinery needed to verify that index
on Ethereum and to settle bounded claims against it.

### 1.2 Contributions

1. **A deterministic index from Bitcoin headers** (§4). It is defined exactly in integers, and it rehashes each
   digest to remove the known byte-level bias of proof-of-work hashes. Its idealized distribution is stated with
   its assumptions.
2. **A header-only verifier with a defined deep-reorganization rule** (§5). The rules are full header
   consensus, a 100-block confirmation depth, and a permanent seal when Bitcoin provably reorganizes past the
   finalized state. The contract stores only the finalized state, not a header history, and has no privileged
   role from deployment onward.
3. **Self-scaling submitter incentives** (§6). An immutable reserve pays a fixed fraction of itself per newly
   finalized height. There are no lifetime points, no burn, and no claim of future fees by past work.
4. **Perpetual bounded accounts** (§7). They price entries and exits only at heights that were unmined when
   requested. They partition cash into protected reserves and close insolvency with one fixed pro-rata ratio.
   Exposure is capped by a rule derived from the cost of a Bitcoin block.
5. **An explicit list of limits** (§9–§10). These include miner selective publication, the public-information
   window, the scope of header-only verification, and mathematical facts about random walks that no contract can
   circumvent.

### 1.3 Non-goals

WUJI does not claim that the index is unbiased in the real world, that it is independent of every asset, or that
holding any claim on it yields a return. "Pure randomness" names the target model, not a proven property of
mining. WUJI is not a price oracle. The quantities it publishes must never be used as a collateral price for
lending. WUJI does not validate Bitcoin transactions or block bodies.

---

## 2. Design constraints and trust model

### 2.1 Constraints

These constraints are fixed. They are not defaults that a later decision may relax.

- No owner, administrator, pause, upgrade path, governance mechanism, or project token. Every parameter is fixed
  at construction.
- Anyone may submit headers, fold the index, process accounts, and claim what they are owed.
- Everything an off-chain service publishes must be recomputable from public data. The off-chain indexer is a
  cache, never an authority.
- Errors are fixed by deploying new contracts that users may migrate to voluntarily. No key can alter balances or
  rules on an existing deployment.
- The source is released under the MIT licence. Off-chain tools (Node.js and a single-file HTML terminal) use
  no third-party runtime dependencies.

### 2.2 What is trusted

The absence of an administrator does not mean the absence of trust. Table 1 lists each layer of the system,
what that layer relies on, and the consequence if that reliance fails.

**Table 1. Trust boundaries**

| Layer | Relies on | If it fails |
|---|---|---|
| Randomness source | Bitcoin proof of work; miners publish what they find | Selective publication biases increments (§9.1) |
| Header verification | Solidity rules (§5); deployment anchor; SHA-256 | Wrong anchor can stall the index; full block validity is not checked (§9.3) |
| Settlement chain | Ethereum consensus and execution | Censorship or reorgs of the host chain delay or reorder calls |
| Liveness | At least one party submits headers and processes accounts | Index and accounts pause; nothing is lost or mis-priced (§9.6) |
| Collateral | ERC-20 behaves normally (WETH in the reference deployment) | Fee-on-transfer, rebasing, freezes or upgrades break accounting assumptions |
| Code | Correctness of immutable contracts | Bugs cannot be patched, only migrated away from |
| Interfaces | User checks of chain, contract and RPC | A cache or front end can display false data without changing contract state |

## 3. Notation and conventions

- `h` is a Bitcoin block height and `B_h` is the raw serialized 80-byte header at height `h`.
- `H_h = SHA256(SHA256(B_h))` is the 32-byte digest **in hash-output (internal) order**. Block explorers display
  the byte-reversed string. `rev(·)` denotes byte reversal, and the proof-of-work comparison uses the integer
  `rev(H_h)`.
- `Σ bytes(x)` is the sum of the 32 bytes of `x`, taken as unsigned integers in `[0, 255]`.
- *wad* denotes fixed-point integers scaled by `10¹⁸`. `S_wad` is the integer the contract stores, and
  `S = S_wad / 10¹⁸`.
- `G` is the genesis height of a deployment, the first height counted, and `G − 1` is its anchor height.
  `K` is the confirmation depth. `L` is the checkpoint interval.
- `⌊x⌋` is the floor function. Integer division in contracts rounds toward zero. Where the contracts use floor
  division on signed values, the text says so.
- "Source" refers to the contract code at commit `4d63357`. "Sepolia v3" refers to the immutable deployment built
  from commit `03f6256` (§11.4). Where they differ, both are stated.

---

## 4. The index

### 4.1 Definition

For every height `h ≥ G` that has been finalized (§5.3):

```text
H_h = SHA256(SHA256(B_h))                    raw 32-byte digest, internal order
R_h = SHA256(H_h)                            hash of the raw digest, not of its hex string
d_h = Σ bytes(R_h) − 4080                    integer in [−4080, 4080]
U_h = Σ_{j=G..h} d_j                         exact integer accumulator
S_wad(h) = U_h × 12 000 000 000 000          the contract's S()
S_h = S_wad(h) / 10¹⁸ = 1.2×10⁻⁵ × U_h
I_h = 100 × exp(S_h)                         display level only
```

Heights are counted in chain order. None may be skipped and none is ever replaced by zero. `S_wad` is exact.
`I_h` is a display convention: it is neither a token price nor a redemption value.

### 4.2 Why the digest is hashed again

A valid proof-of-work digest satisfies `rev(H_h) ≤ target`, so its high-order bytes are constrained. If one
assumes valid digests are uniformly distributed on `[0, target]`, the expected byte sum of `H_h` can be computed
exactly. Let `M = target + 1`. For byte position `j` with weight `b = 256^j`, let `r = M mod 256b` and
`q = ⌊r / b⌋`. The total of byte `j` over all `M` values is then

```text
⌊M / 256b⌋ · b · 32640 + b · q(q − 1)/2 + q · (r mod b)
```

Summing over `j = 0..31` and dividing by `M` gives the mean. At Bitcoin height 800 000
(`nBits = 0x17053894`) the mean is **2802.883**, far from the 4080 a uniform 32-byte string would have, and it
drifts as difficulty changes. Centring the raw digest at 4080 would therefore build a deterministic downward
drift into `U`. The extra hash `R_h = SHA256(H_h)` mixes the constrained input in the random-oracle model. This is
the reason for the design. It is not a claim that miners cannot select which blocks to publish (§9.1).

### 4.3 Distribution under the ideal model

**Proposition 1 (ideal increments).** Assume the 32 bytes of each `R_h` are independent and uniform on
`{0, …, 255}`, increments at different heights are independent, and every mined block is published. Then:

```text
E[d_h] = 0
Var[d_h] = 32 × (256² − 1) / 12 = 174 760        sd(d_h) ≈ 418.043
sd(ΔS) per height    = 1.2×10⁻⁵ × 418.043 ≈ 0.0050165
sd over 144 heights  ≈ 0.060198
sd over 52 596 heights (365.25 × 144) ≈ 1.1505
max |ΔS| per height  = 4080 × 1.2×10⁻⁵ = 0.04896 ≈ 9.76 sd
```

*Proof.* Each byte has mean 127.5 and variance (256² − 1)/12. Sum the 32 independent bytes, then scale by
`1.2×10⁻⁵`. Scale by `√n` for `n` independent heights. ∎

The figures 144 and 52 596 convert heights into calendar time using Bitcoin's 10-minute target. They are not
measured daily or annual volatilities, because block times vary. `d_h` has finite discrete support
`{−4080, …, 4080}` and is not a truncated normal variable. Being reproducible answers *how* the index is
computed. Unpredictability, resistance to manipulation, and independence from other assets each need further
assumptions, which §9 examines.

### 4.4 Checkpoints

Series boundaries are the heights

```text
T_m = G − 1 + m · L,     m ≥ 1,     L = 4320
```

When a fold crosses `T_m`, the contract records `checkpointS(T_m)` exactly once and never changes it. A boundary
interval averages about 30 days of Bitcoin time, which is not a calendar deadline. A checkpoint is a record of
the index. Applications decide whether and how to use it.

### 4.5 Test vector

At height 800 000, the explorer hash and its byte reversal `H` give:

```text
explorer = 00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054
H        = 54a02827d7a8b75601275a160279a3c5768de4c1c4a702000000000000000000
R        = 74323d1b46bfc56d162ea5725ebc666028c5ee2b0a4824e32dedff53fe3ec1fd
d        = −187
ΔS_wad   = −2 244 000 000 000 000
```

Hashing the explorer string, or its ASCII bytes, gives a different and wrong result. The vector is checked by
JavaScript and Solidity tests and by the zero-dependency verification kit (Appendix D).

<!-- pagebreak -->

## 5. Verifying Bitcoin headers on Ethereum

`WujiHeaderIndex` (`contracts/src/WujiHeaderIndex.sol`) is the mainnet-path verifier. It keeps no relay of past
headers. Its state is the **finalized continuity**, everything the next header is checked against:

```text
Continuity { hash, height, bits, time, epochStart, u }
recentTimes[11]     timestamps of the 11 headers ending at the finalized height
chainWork           cumulative work since the anchor
committedAt[h]      keccak256 commitment to (Continuity, recentTimes, chainWork) after every fold
seenHeight, seenTime  newest header ever validated (folded or not)
frozen              set once, by Rule 3
```

The constructor takes an anchor header at height `G − 1`, the timestamp at which the anchor's difficulty epoch
began, and the 11 ancestor timestamps that seed median-time-past. It checks the anchor's own proof of work and
version floor and records `committedAt[G − 1]`. Cumulative work is measured from the anchor. Only differences in
work matter, so the omitted common prefix cancels.

### 5.1 Rule 1: header validity

A header `B` extending state `P` (the parent) to height `n = P.height + 1` is accepted only if **all** of the
following hold (`_apply`):

1. **Length and linkage.** `B` is 80 bytes and its previous-hash field equals `P.hash`.
2. **Difficulty.** If `n mod 2016 = 0`, `nBits` must equal `retarget(P.bits, P.epochStart, P.time)`. Otherwise
   it must equal `P.bits`. The retarget follows Bitcoin Core: `elapsed = P.time − P.epochStart` is clamped to
   `[T/4, 4T]` with `T = 1 209 600 s`, the new target is `old · elapsed / T` capped at the proof-of-work limit, and
   the result is re-encoded in compact form and compared exactly.
3. **Median-time-past.** `B.time` must be strictly greater than the median of the parent branch's previous 11
   timestamps. The window is copied before sorting, so the oldest header is evicted rather than the smallest
   timestamp. This was a defect in an earlier deployment (§11.4).
4. **Future bound.** `B.time ≤ block.timestamp + 7200`, using the host chain's clock.
5. **Version floors (source).** The signed 32-bit `nVersion` must be at least 2, 3 and 4 from heights 227 931,
   363 725 and 388 381 respectively. These are the BIP34, BIP66 and BIP65 buried deployments.
6. **Proof of work.** `rev(H) ≤ target(nBits)`. The decoder rejects negative, zero and overflowing encodings, and
   any target above `2²²⁴ − 1`.

A header's work is `⌊(2²⁵⁶ − 1 − t) / (t + 1)⌋ + 1` for target `t`, which is Bitcoin Core's `GetBlockProof`. The
same `_apply` routine is used for folding and for reorganization proofs, so both paths enforce identical rules.

**Not verified.** Transactions, scripts, Merkle roots against block bodies, block weight, coinbase rules, and
soft-fork rules triggered by transactions are outside the contract's scope. Header acceptance is SPV-level
verification, not full Bitcoin consensus. These omissions do not lower the work an attacker must perform. They
do mean that a chain of headers can be valid here while full nodes reject its blocks, at the full cost of its
proof of work (§9.3).

**Difficulty cannot be manipulated cheaply.** A branch keeps the parent's difficulty except at a retarget
boundary. At a boundary, `elapsed` runs from the epoch's first timestamp to its last. The first timestamp comes
from the already-finalized chain. The last is bounded by host time plus two hours, and rule 3 forces timestamps
upward. A private branch can therefore lower its difficulty only as fast as real time actually passes. It
cannot fast-forward the clock to make blocks cheaper.

### 5.2 Rule 2: confirmation depth

`foldHeaders(headers, rewardTokens)` takes `n` contiguous headers, where `K < n ≤ 512`, starting from the
finalized tip. It validates all `n` of them and advances the finalized state by `n − K` heights. The last `K`
headers act only as confirmations. They advance `seenHeight` but are not counted in `S`, and the next fold must
resubmit them. The continuity is snapshotted **by value** at height `tip + n − K`. Later headers in the same call
cannot alter it.

`K = 100` on the mainnet path, equal to Bitcoin's coinbase maturity. Bitcoin itself treats 100 blocks as the
depth at which newly minted coins become spendable.

**Proposition 2 (cost of a false fold).** To fold any height whose header is not on the honest chain, an
adversary must supply at least `K + 1` headers of valid proof of work, linked to the finalized state, at the
difficulty that Rule 1 enforces from that state.

*Proof.* Folding a height `x` requires `K` valid headers after `x`, plus the header at `x` itself, all
satisfying Rule 1 from the finalized state. If `x` is not on the honest chain, neither are its descendants, so the
adversary must mine all `K + 1`. The difficulty is inherited from the finalized state. By the argument at the end
of §5.1, it cannot fall faster than real time allows. ∎

At the current 3.125 BTC subsidy, `K + 1 = 101` blocks represent more than 315 BTC of block subsidy alone,
before fees. This is the minimum cost of inserting a single false increment into `S`. It is a bound on the work
required, not on attacker profit.

### 5.3 Rule 3: deep-reorganization seal

If Bitcoin reorganizes past the finalized tip, real headers no longer link to the tip, and folding stops. Rule 3
turns that silent halt into a definite, permissionless outcome. `freezeOnReorg(base, headers)` seals the index
permanently if:

1. `base` is a state at some height `b < tip.height` whose commitment equals `committedAt[b]`. A fork can start
   only from a state the contract itself recorded.
2. `headers` form a branch from `base` that satisfies every check in Rule 1.
3. The branch never passes through `(tip.height, tip.hash)`. Doing so would be an extension, not a reorg.
4. The branch ends above `tip.height`, and its cumulative work satisfies

```text
W_branch ≥ chainWork + (K + 144) · work(target(tip.bits))
```

Sealing sets `frozen = true` and emits the last consistent `S`. Afterwards no fold can succeed. `S`, its
checkpoints and every recorded history remain readable, and nothing is rolled back. Consumers exit on what was
recorded (§7.7).

**Long reorganizations.** A single call accepts at most 800 headers, which fits within the 2²⁴-gas per-transaction
cap introduced by EIP-7825. For longer branches, `beginReorg` and `extendReorg` authenticate segments of up to
256 headers each and store only a hash of the running proof. `freezeReorg` then checks the final proof against
the **current** finalized tip and threshold. Candidates do not reserve any global slot or block normal folding.
The threshold is never snapshotted: if the original chain keeps advancing, the bar rises with it. The segment
size limits the work done per transaction. It does not limit the depth of reorganization the contract can
handle.

**Proposition 3 (cost of a false seal).** Sealing without a real reorganization requires privately mining a
branch whose work exceeds that of the finalized chain after the fork point by at least 244 blocks at the tip's
difficulty. That is at least 245 blocks.

*Proof.* The fork point satisfies `b ≤ tip.height − 1`, so the finalized chain after `b` contains at least one
block. Condition 4 requires branch work of at least the finalized work after `b` plus `(K + 144)` blocks'
worth. ∎

A false seal does not move `S`. It only ends the index early, and consumers then exit at recorded values. The
attacker's gain is therefore limited to whatever an early exit is worth to their positions (§9.2). During a
genuine deep reorganization the index stalls from the moment real headers stop linking to the finalized tip
until a seal proof crosses the threshold. The replacing chain must already out-work the displaced one to have
replaced it, so the remaining wait is at most about 244 further blocks (about 1.7 days at the target rate).
Pools stop accepting requests once the index is 24 hours stale (§7.2).

### 5.4 The seen header

Pools need a lower bound on the current Bitcoin tip that the index itself has validated, so that they can
choose pricing heights that cannot exist yet. `seenHeight` is the highest height of any header validated in a
fold, including confirmation headers. `seenTime` is its timestamp. In the source, `seenTime` is capped at the
11-block median plus 3 hours (`MAX_SEEN_MTP_LEAD`). The cap stops a privately mined, future-stamped block from
making a lagging index look fresh. Sepolia v3 stores the raw timestamp without this cap.

### 5.5 Bounds and gas

| Operation | Bound | Measured |
|---|---|---|
| `foldHeaders` | ≤ 512 headers per call | ≈ 17 620 gas per header on Sepolia, all-in (140 headers, 2 466 827 gas); local linear fit ≈ 75 000 + 18 550 per header |
| `freezeOnReorg` | ≤ 800 headers | about 15 M gas at the cap (design estimate; to be re-measured on the release chain) |
| `beginReorg` / `extendReorg` | ≤ 256 headers per segment | seal drill: 30-deep reorg sealed with 284 headers, 4.33 M gas |

Every fold must resubmit the `K` confirmation headers. A keeper folding `f` times a day therefore submits about
`144 + 100f` headers a day (§6.3).

## 6. Operations reserve and submitter incentives

Submitting headers costs gas, and someone must pay it. WUJI pays submitters from an immutable reserve and never
from a privileged budget.

### 6.1 Mechanism

- `FeeRouter` (`contracts/src/FeeRouter.sol`) forwards 100 % of the fees it receives into `RelayerRewards` via
  `route(token)`. Anyone may call it. Nothing is burned.
- `RelayerRewards` (`contracts/src/RelayerRewards.sol`) holds a separate reserve for each token. Anyone may
  `fund` it. A direct transfer becomes reserve only after `sync`, and it can pay only future work, never heights
  already finalized. Donations confer no rights.
- Only the index may call `credit(worker, from, to, tokens)`. The height range must be contiguous: each call
  starts exactly at the previous `to + 1`. For each selected token, the reserve `r` is debited height by height:

```text
for each height:  bounty = ⌊r / D⌋;  r ← r − bounty        D = 100 000
```

- The caller selects at most 8 tokens, sorted and unique, and at most 512 heights per rewarded call (256 on
  Sepolia v3). Heights folded with no tokens, with unselected tokens, or against an empty reserve are consumed
  permanently and create no later entitlement.
- `claim(token)` pays only amounts already allocated. It never syncs new funds and never re-shares future
  income.

**Proposition 4 (conservation and batch neutrality).** For each token, `reserve + allocated` equals the
accounted balance, and an unsynced direct transfer can only make the true balance larger. Splitting a range
into several calls yields exactly the same total bounty as one call.

*Proof.* `credit` moves value from `reserve` to `allocated` and `claimable`. `claim` reduces `allocated` by the
amount transferred and checks the balance difference. The per-height loop is sequential, so its result depends
only on the number of heights credited and not on how they are grouped. ∎

### 6.2 Decay

With no new funding, and with every height rewarded in a token, the reserve decays as `r_h = r_0 (1 − 1/D)^h`,
ignoring rounding to integer units. At 144 heights a day this pays out about **0.1439 % of the reserve per day**,
a half-life of about **481 days**. The divisor was raised from 10 000 to 100 000 on 2026-10-02 so that a single
donation pays submitters for years rather than weeks. Earlier deployments keep 10 000 (half-life about 48 days).
A nonzero reserve does not guarantee that anyone will find submitting profitable.

### 6.3 Cost model

At 17 620 gas per header and 144 + 100f headers a day:

**Table 2. Daily keeper cost and break-even reserve (D = 100 000; scenario arithmetic, not quotes)**

| Folds/day `f` | Gas/day | ETH/day at 0.1 gwei | ETH/day at 1 gwei | Reserve for break-even at 1 gwei |
|---:|---:|---:|---:|---:|
| 1 | 4.30 M | 0.00043 | 0.00430 | 2.99 ETH |
| 2 | 6.06 M | 0.00061 | 0.00606 | 4.21 ETH |
| 4 | 9.59 M | 0.00096 | 0.00959 | 6.66 ETH |

Here "break-even" means that the daily bounty, `0.001439 · r`, equals the daily gas cost. Server, RPC and data
costs are excluded. Measured operation on Sepolia v3, 16–22 October 2026: 34 keeper transactions,
81 564 271 gas, 0.0081564271 Sepolia ETH over seven non-overlapping daily windows. Pool fees were zero, so
bounties were zero. **The testnet keeper is subsidized. The protocol is not yet economically self-sustaining.**
The mainnet plan, decided on 2026-10-04, starts the reserve at zero and has the project's own keepers pay gas
until fees accumulate.

---

## 7. Perpetual accounts

`WujiAccounts` (`contracts/src/WujiAccounts.sol`) is the mainnet-path application. An account takes one side of
the index, YANG (long `S`) or YIN (short `S`), with fixed principal and no expiry. Its value is bounded below by
zero and above by twice its principal. Each pool has one collateral and one sensitivity `K_pool`. The factory
fixes a menu of three pools per collateral.

### 7.1 Value

On entry a depositor pays `a`. The fee is `⌈a · φ⌉`, with `φ = 30 bps`, and the principal is
`p = a − ⌈a · φ⌉`. The pool tracks live principal per side, `P_yin` and `P_yang`, and an accumulator per side.
When an epoch with index value `S_e` is processed:

```text
ΔS   = S_e − S_prev
m    = min(P_yin, P_yang)                          matched principal
move = ΔS · 10²⁷ / K_pool
acc_yang += ⌊ move · m / P_yang ⌋                   floor division, signed
acc_yin  += ⌊ −move · m / P_yin ⌋
```

An account's nominal value at the last processed epoch is

```text
v = clamp( p + ⌊ p · (acc_end − acc_entry) / 10²⁷ ⌋ ,  0,  2p )
```

**Properties.** (i) When both sides are fully matched (`P_yin = P_yang`), `v ≈ p · (1 ± ΔS / K_pool)` over the
holding period, with `+` for YANG and `−` for YIN. Profit and loss is additive in `S`, so there is no volatility
drag of the kind a compounding position suffers. (ii) Before flooring and clamping, the two sides' changes are
exactly opposite: `+move·m` and `−move·m`. The larger side's sensitivity is scaled down by `m / P_side`, because
its excess principal is unmatched. (iii) Matching varies from epoch to epoch, so realized profit and loss
depends on the path of matching and not only on the net change in `S`.

**Volatility tiers.** Under Proposition 1, `S` has an annualized standard deviation of about 115 %. A pool's
nominal annual volatility is therefore about `115 % / K_pool`:

| Tier | `K_pool` | Nominal annual volatility (ideal model, full matching) |
|---|---:|---:|
| 0 | 23 | 5 % |
| 1 | 11.5 | 10 % |
| 2 | 4.6 | 25 % |

These labels are model scales. They do not guarantee the volatility of any account or its chance of reaching
zero.

### 7.2 Pricing at unmined heights

A request is never priced at a height whose increment might already be known. On an index without a relay, a
request made at time `t` is priced at

```text
h* = roundUp_6( seenHeight + M(age) ),    age = t − seenTime, rounded up to whole hours b ∈ {0, …, 24}
M(b) = min{ m : P[ Poisson(λ_b) ≥ m ] ≤ 10⁻⁷ },   λ_b = 1.25 × 6 × (b + 2)
```

Requests are refused when `seenTime` is more than 24 hours old or more than 2 hours in the future. The rate
factor 1.25 allows for blocks arriving faster than one per ten minutes between retargets. The `+2` hours allows
for header timestamps that run up to two hours ahead of real time. The 25 margins are fixed in the contract as a
byte table, from `M(0) = 40` to `M(24) = 273` (Appendix C). This paper's recomputation reproduces all 25.

**Proposition 5 (unmined pricing height).** Suppose blocks after `seenHeight` arrive as a Poisson process with
rate at most `1.25 × 6` per hour, and `seenTime` is at most two hours ahead of the true time at which that
block was mined. Then the probability that height `h*` already exists when the request is executed is at most
`10⁻⁷`.

*Proof.* The time elapsed since block `seenHeight` was mined is at most `age + 2` hours. The number of blocks
mined in that time is stochastically dominated by `Poisson(λ_b)`. `h* ≥ seenHeight + M(b)` by construction. ∎

**What remains outside Proposition 5:** a sustained block rate above 1.25 times the target for the whole
`age + 2` hours, and block timestamps more than two hours fast. With an index refreshed within the last hour, `h*` lies 52 blocks
(about 9 hours) ahead, or 40 if the header is less than a second old. Processing it requires that height to be finalized: 100 more headers (about 17 hours)
plus a fold. The total wait is therefore about a day and is not guaranteed.

On an index with a relay (a historical configuration), a request is priced at the relay's best height plus
`DELAY = 16`, and requests are accepted only while the best header is at most 30 minutes old.

### 7.3 Life cycle and processing

- **Entry.** `requestEnter(side, a)` collects `a` and verifies that exactly `a` arrived (short-paying tokens are
  rejected). It adds the fee to the buffer and queues the principal at `h*`. Pending principal carries no
  exposure.
- **Exit.** `requestExit(id)` is irrevocable and queues the account at a later `h*`. Exposure continues until
  that epoch. In the source, exit is refused for an account already at value zero.
- **Processing.** Anyone may call `process()` or `processMany()`. An epoch below the finalized tip is priced
  from raw headers that anyone may supply: `markWithHeaders` recomputes `S_e = S_tip − Σ increments(e+1..tip)` and authenticates each
  header by hash linkage back to `tip.hash`. Forging this would require a SHA-256 second preimage. One call
  handles at most 64 accounts. While an epoch is mid-settlement, new requests, retirements and sweeps wait, but
  previously reserved claims remain payable.
- **Claim.** A processed exit pays `v − ⌊v · φ⌋`. `transfer(id, to)` moves ownership. Accounts are not fungible
  tokens.

### 7.4 Cash partition and deterministic insolvency

The pool's balance is split into protected reserves and the rest:

```text
available = balance − pendingPrincipal − refundReserve − reservedClaims
```

`pendingPrincipal` is entries not yet priced. `refundReserve` is refunds not yet claimed. `reservedClaims` is
priced exit amounts not yet claimed. At each epoch the pool values **every** live account, giving `owed = Σ v`.

- If `owed ≤ available`: the fee buffer absorbs any shortfall caused by accounts that overshot zero between
  epochs (`buffer ← min(buffer, available − owed)`). Exits become reserved claims, and exit fees join the
  buffer.
- If `owed > available`: the pool closes **permanently and automatically**. Every remaining live claim is paid
  `⌊v · available / owed⌋`, and `badDebt = owed − available` is recorded. Pending entries are refunded in full,
  and claims reserved earlier are paid in full.

**Proposition 6 (claim-order independence).** After an insolvency close, each account's payout depends only on
its own `v` and the two numbers fixed at the close. The order and timing of claims cannot transfer the shortfall
between accounts.

*Proof.* `available` and `owed` are stored once, as `settlementAssets` and `settlementLiabilities`. Every later
payout is `mulDiv(v, settlementAssets, settlementLiabilities)`, and protected reserves are excluded from both
numbers. ∎

### 7.5 Fees, buffer and bounties

| Item | Rule (source) | Sepolia v3 |
|---|---|---|
| Entry fee | `⌈a · 30 bps⌉`, added to the buffer | same |
| Exit fee | `⌊v · 30 bps⌋`, added to the buffer when the exit is priced | same |
| Processing bounty | `buffer / 10 000` per processed epoch (and per first-time bridge mark) | same |
| Retirement bounty | `min(buffer / 10 000, p · 30 bps / 2)`, at most half the account's own entry fee; none in a frozen pool | `buffer / 10 000` |
| Sweep | buffer above 10 % of (live + pending principal) goes to `FeeRouter`, then to the reserve; with no open accounts, the whole balance is swept | same |

`retire(id)` removes an account at value zero so that it stops diluting the matched amount. The cap on the
retirement bounty prevents a dust account from draining the buffer one floor-rounded step at a time.

### 7.6 Exposure cap

A miner who can withhold blocks can bias `S` (§9.1). The pools are the main place where exposure to `S`
accumulates, so the source caps each side of each pool:

```text
cap(h) = MAX_PRINCIPAL >> max(0, ⌊h / 210 000⌋ − CAP_ERA)
MAX_PRINCIPAL = K_pool · B / 3          per tier, for a factory budget B
```

`h` is the entry's pricing height, so the cap halves at every Bitcoin subsidy halving. An entry is accepted only
if live principal plus pending principal plus the new principal on that side stays within `cap(h)`. The minimum
principal is `cap >> 14`, which allows at most 16 384 active accounts per side. Because there are three tiers,
`Σ_tiers cap / K_pool = B`. The factory accepts a single collateral, so the menu cannot be multiplied by opening
pools in other tokens. Sepolia v3 predates this rule and has no cap.

**Proposition 7 (withholding is unprofitable in expectation under the cap).** Let an adversary's only
exposure to `S` come from the pools, so that `|∂wealth/∂S| ≤ E ≤ Σ m_i / K_i ≤ B`. Let `c_b` be the adversary's
private cost of discarding one block, or of mining one block on a private branch. Under the random-oracle model,
each sacrificed block changes the adversary's expected terminal wealth by at most `E · ΔS_max = 0.04896 · E`.
Hence if `B · 0.04896 < c_b`, no withholding or private-branch strategy increases expected wealth. Without the
random-oracle assumption, the worst-case realized change per block is `2 · ΔS_max`.

*Proof.* Discarding a block with known increment `δ` replaces it with a fresh increment of mean zero, which is
independent of the adversary under the random-oracle model. The expected change in `S` is therefore `−δ`, with
`|δ| ≤ ΔS_max`, at a cost of `c_b`. The argument applies to each sacrificed block in turn. The worst-case bound
follows from `|δ₂ − δ₁| ≤ 2 · ΔS_max`. ∎

Counting the 3.125 BTC subsidy alone, the expectation bound gives `B < 63.8 BTC`-equivalent per unit of `S`, and
the worst-case bound gives `B < 31.9 BTC`-equivalent. The proposed mainnet budget is about 16 BTC-equivalent:
four times inside the first bound and twice inside the second. A first launch would trial a far smaller budget,
for example `B = 3 ETH`. **These budgets are proposals, not deployed parameters.** The cap covers only official
pools. Exposure to `S` held elsewhere, in other contracts or off chain, adds to an attacker's incentive and is
outside any contract's control. Pools are denominated in ETH while `c_b` is in BTC, so a rise in the ETH/BTC rate
enlarges real exposure. A miner's private cost can also be below the subsidy.

### 7.7 Behaviour after a seal

When the index is sealed, `freezePool` drains the queue in bounded batches. Each queued epoch at or below the last
finalized height is priced at **its own** hash-authenticated `S`. If those headers are temporarily unavailable,
closing waits and never substitutes another price. Entries queued for heights above the finalized height are
refunded in full. Open accounts are then valued at the sealed `S` and become claimable. A settlement already in
progress keeps its price. Nobody gets to choose a convenient value.

## 8. Reference application: fixed-term paired claims

`WujiVault` (`contracts/src/WujiVault.sol`) is retained as a reference implementation bound to the earlier
relay-based index (`WujiIndex` with `BitcoinRelay`, 6 confirmations). It is **not** the mainnet target product.
One pair consists of a YANG token and a YIN token minted against notional `N`. With `g(x) = min(1, max(0, ½ + x/2))`:

```text
YANG gross payoff at boundary T = N · g(S_T − S₀)        YIN = N − YANG
```

Paired redemption is always available, and single-sided redemption opens after settlement. Fees are 5 bps on
mint and on redemption. Settlement reads only the recorded checkpoint at `T`, so calling later cannot select a
later value. Under ordinary ERC-20 behaviour, the vault balance covers all liabilities across series.
`g(S − S₀)` is an instantaneous settlement share, not a price. Before `T`, even an idealized fair value is the
conditional expectation of the final payoff, which generally differs from `g`. Anyone may create a vault through
`WujiVaultFactory`; the ability to create one is not an endorsement of the collateral.

---

## 9. Security analysis

### 9.1 Miner selective publication

A miner who finds a valid block can compute its increment before publishing, then discard the block or mine
privately. Rehashing (§4.2) removes the deterministic bias of raw digests. It does not prevent this selection.
The cost to the attacker is their private marginal cost per block, which depends on pool arrangements, fees,
and external positions, and is not simply the network block reward. Proposition 7 bounds the incentive coming
from official pools. Exposure held elsewhere is unbounded by WUJI. Folding a false increment, rather than biasing
which true block gets published, requires at least `K + 1 = 101` private blocks (Proposition 2).

### 9.2 Public-information window

Once a Bitcoin block is public, its increment is known to everyone, long before it is finalized on Ethereum.
Anyone trading on stale state can be picked off. Perpetual accounts close this window **for their own entries
and exits** by pricing only at heights that were unmined when requested (Proposition 5). Fixed-term tokens and any
secondary market remain exposed. The confirmation depth protects against reorganizations, not against unequal
access to information.

### 9.3 Scope of header-only verification

The contract enforces header consensus (§5.1) but not block validity. An attacker with enough hash power could
produce headers that the contract accepts and full nodes reject, but only at the full proof-of-work cost. The
contract also cannot tell whether a branch it has seen is the globally heaviest valid chain. It knows only that
the branch has the work it has. Consensus changes in Bitcoin that are incompatible with these header rules
would stall the index.

### 9.4 Deployment anchor

The anchor header, its height, the timestamp of its difficulty epoch, and its 11 ancestor timestamps are trusted
at construction and must be checked against independent Bitcoin nodes. A wrong epoch start makes the first
retarget compute the wrong `nBits`. Real headers are then rejected (a liveness failure), and a false chain at the
miscomputed difficulty would still need `K + 1` mined blocks to fold. The source rejects an anchor at a retarget
height whose epoch start differs from its own timestamp, and it requires `G = anchorHeight + 1`.

### 9.5 Clocks and freshness

The future bound uses the host block timestamp. On Ethereum L1 under proof of stake, timestamps are fixed by
slot (`genesis + 12 · slot`). Some L2s let sequencers move timestamps by hours, which would erode the pools' age
margins. Any L2 deployment must document this. Pool freshness uses `seenTime`. The 3-hour median cap (§5.4)
limits how much a single future-stamped orphan block can make a lagging index look fresh.

### 9.6 Liveness

If nobody submits, the index stops advancing. Once `seenTime` is more than 24 hours old, pools refuse new
requests. Queued requests wait. Nothing expires, nothing is mis-priced, and anyone, including an account owner,
can resume by calling `foldHeaders`, `process`, `retire` or `claim`. The zero-dependency keeper includes a Bitcoin
P2P client that validates headers from Bitcoin's genesis block, so it needs no third-party API. Liveness depends
on someone being willing to pay gas (§6.3). The "disappearance drill", which tests whether the protocol keeps
running with its authors absent, has not been completed.

### 9.7 Collateral, host chain and interfaces

The reference collateral is WETH, which has no issuer able to freeze it. Pools reject short-paying tokens, but
they cannot defend against rebasing, upgradeable or freezable tokens. Claims are denominated in collateral
units and do not hedge ETH's price. The terminal enables wallet actions only for pools in its built-in release
list, and re-verifies code hashes and parameters at a fresh block before signing. An indexer can display false
data but cannot direct deposits.

### 9.8 Immutability

No key can fix a bug in a deployed contract. A new version is a new deployment, and moving to it is voluntary.
This removes administrative risk, and it means review must happen before deployment, not after.

### 9.9 Why the zero-knowledge path is not on mainnet

A succinct-proof variant (`ZkWujiIndex`) was built and measured. On Sepolia it folds a proven batch of 100 real
headers for 453 888 gas, against 1 928 070 gas for the same headers through the Solidity rules. A challenge
window was added in which disputed batches must be backed by raw headers. It was not adopted for mainnet. It
would add the proof system, its trusted setup and its verifier contract to the trusted base. Three soundness
advisories were published for that proof system between early 2025 and April 2026. It would also need about
31 GB of memory per proof and would add latency, bonds, disputes and watchers. The header path verifies the same
rules with the EVM and a few hundred readable lines, at a cost that is affordable on L1 (Table 2). The code
remains in the repository as a measured research result.

## 10. Mathematical limits: what the index does not promise

1. **Convexity is not income.** Under Proposition 1, `E[ΔS] = 0`, yet the display level `I = 100 · e^S` drifts
   upward: `E[I_n] = I₀ · (E[e^ξ])ⁿ > I₀`. This is Jensen's inequality, not cash flow. Every payout comes from
   collateral posted by counterparties, minus fees.
2. **Waiting does not guarantee a target.** If a price `P` is a non-negative martingale with `P₀ > 0` and
   `H > P₀`, then `P[sup_t P_t ≥ H] ≤ P₀ / H` by optional stopping. No contract can offer a claim that is non-negative,
   has zero expected price change, and is certain to reach every target eventually. For example, buying at 100
   and targeting 110 succeeds with probability at most about 90.9 %.
3. **Four objects, never conflated.** The index `S` is not the instantaneous settlement share `g`, which is not a
   payoff at expiry, which is not a market price `Q`. Only `Q` is what someone will actually pay.
4. **Correlation is not independence.** A near-zero sample correlation with any asset does not establish
   independence. Block-production timing in calendar time, collateral value, and market prices can all introduce
   dependence.
5. **Counting only realized wins is biased.** An evaluation that ignores positions still waiting to recover
   systematically overstates performance. Public studies should pre-register heights, metrics, all strategies
   tried, costs, and out-of-sample splits.

---

## 11. Implementation, verification and evidence

### 11.1 Code

The contracts are Solidity 0.8.x, built with solc 0.8.28, optimizer at 200 runs, Prague EVM target, and no via-IR.
OpenZeppelin is the only vendored dependency. Runtime sizes at the source commit: `WujiHeaderIndex` 12 489 bytes,
`WujiAccounts` 24 329 bytes (247 bytes under the EIP-170 limit), `RelayerRewards` 4 660, `FeeRouter` 1 115. The
factory splits the pool's creation code into two immutable, non-executable data contracts and re-joins them at
creation. It uses no proxy.

### 11.2 Tests and analysis

- Foundry unit, fuzz, invariant and real-data suites: at the source commit, 347 tests in 35 suites pass and 24
  are skipped by default (20 November 2026). Financial invariants run with `fail_on_revert = true`.
  An earlier release candidate passed ten seeded shards of 100 runs at depth 100 per handler; this must be
  repeated on the release commit.
- Real-header fixtures: 6 060 mainnet headers (heights 798 336–804 395, four retargets) and 345 timestamp vectors
  derived from Bitcoin Core. Every `R` and every cumulative `S` is checked in both Solidity and JavaScript.
- **Full-history replay**: every Bitcoin mainnet header from height 11 to 969 692 replayed through
  `WujiHeaderIndex` in 24 segments and matched against an independent computation of `S`, work and tip hash. A
  corrupted expectation, a flipped timestamp bit, and a flipped difficulty bit each cause failure. The replay
  must be re-run on the release commit.
- Static analysis with Slither and Aderyn, re-run on 2026-10-26: no vulnerability after triage.
- **Seal drill** on a fork network: the production keeper folds a mined chain, a pool processes entries, Bitcoin
  reorganizes 30 blocks below the finalized tip, and the keeper waits, then seals by itself (284 headers,
  4.33 M gas). The pool freezes, and all accounts are paid to the last unit, one refunded in full.
- A first-principles audit-hardening pass, merged on 2026-11-15, added the version floors, the median cap on
  `seenTime`, the cap on retirement bounties, and the ban on exits at zero value, among other changes. It was
  performed by the project, not by an independent firm.

### 11.3 Independent recomputation

The `verification/header-v3` kit is a zero-dependency, read-only package. It fixes one Sepolia block
(11 969 645), the index address and its parameters. It fetches headers from public sources, replays them offline
and compares the results with contract state. The author's runs pass 28 of 28 on Node 18 and Node 26. A request
for external replay was published on 2026-10-23. As of this version, no independent replay or security-review
report is recorded in the repository.

### 11.4 Deployments (Ethereum Sepolia)

**Table 3. Sepolia v3 (source `03f6256`, deployed 2026-10-12)**

| Contract | Address |
|---|---|
| `WujiHeaderIndex` | `0x4a70Ebc03DA98f04d88964E17dF212ba1bb2705a` |
| `RelayerRewards` | `0xe6933fB941861b6Ef3888Eb11e2Dfb476B3aAB35` |
| `FeeRouter` | `0xcc32633A49eDf61400cBc48a0eE082a8866946b4` |
| `WujiAccountsFactory` | `0xF2C7BAa3Cdd8a69c2ED2576478140d13c29c48a9` |
| Pool, K = 23 (WETH) | `0xbfdcebf9dd77ddfd12e9be020564ab4e16d4ae68` |
| Pool, K = 11.5 (WETH) | `0x8cdf42009548483f25fe4bcd6ac00bbb88e2bf14` |
| Pool, K = 4.6 (WETH) | `0xcd159a006aeb31535ead9514a9ea335466c9c137` |
| Collateral (WETH) | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |

Parameters: anchor height 969 545, `G = 969 546`, `K = 100`, margin 144, `L = 4320`, first checkpoint 973 865,
reserve divisor 100 000. Runtime bytecode and constructor bindings of all nine contracts were verified against
the source at deployment. A real MetaMask pair of accounts (one YANG, one YIN) completed entry, exit and claim on
2026-10-22; every fee and a 1-wei rounding loss were reconciled exactly.

**On-chain observation (one reading, not a health guarantee).** At Sepolia block 12 175 481 (20 November 2026),
`lastHeight() = 976 624`, `seenHeight() = 976 724` (the Bitcoin tip was 976 728), `frozen() = false`,
`S() = −0.188232` (`U = −15 686`), and the first checkpoint was recorded: `checkpointS(973 865) = 0.100092`
(`U = 8 341`). These values were read through a public RPC and were not independently recomputed for this paper.

**Table 4. Source changes not present in Sepolia v3**

| Component | Change in source `4d63357` |
|---|---|
| `WujiHeaderIndex` | BIP34/66/65 version floors; `seenTime` capped at the median + 3 h; anchor consistency checks |
| `RelayerRewards` | `MAX_HEIGHTS` 256 → 512 |
| `WujiAccounts` | per-side exposure caps halving with the subsidy; minimum principal; cap on retirement bounties; exit refused at value zero |
| `WujiAccountsFactory` | single collateral; exposure budget validated at construction |

Earlier deployments are retained as historical records and are not upgraded. The first header-index deployment
contained a median-time-past defect, which was fixed in a redeployment (v2) on 2026-10-12. v3 added that day's
security revisions. Relay-based deployments are also retained.

## 12. Deployment status and open gates

**Mainnet path** (decided 2026-10-02 to 2026-10-04): Ethereum L1. Stage 1 is the index, reserve and router, with
no user deposits and the reserve starting at zero. Stage 2 adds the pools, after independent review. No mainnet
date is set.

Gates that remain open:

1. Independent security review of the exact release commit: the index against Bitcoin Core semantics, the
   seal path, the pools, and the pricing-margin table.
2. Re-running the full-history replay, static analysis and gas measurements on the release commit and the target
   chain, including the worst-case seal.
3. Selecting the anchor near the tip at deployment, cross-checked against two independent Bitcoin nodes.
4. At least two independent keepers, each with its own RPC and key, under supervision.
5. Observation of a full 4 320-height series on testnet, including pool entries and exits processed from
   headers.
6. Fixing the exposure budget and first-launch limits; publishing an exposure policy and its assumptions about
   private cost.
7. A completed disappearance drill.
8. Deterministic CREATE2 deployment and a native-ETH design, which remain unimplemented.

Completing a stage does not approve real funds for any later stage.

---

## 13. Related work

**Bitcoin header relays on Ethereum.** BTC Relay (2016) was the first SPV relay. Summa's relays reduced storage.
tBTC's LightRelay stores only headers around retargets and is `Ownable`. Draft ERC-8002 specifies an SPV gateway
interface. Tacit's `BitcoinLightRelay`, live on mainnet since 2026-09-18, checks the same header rules
permissionlessly after a one-shot genesis. **A full-rule, permissionless header verifier in Solidity is
therefore not new, and WUJI does not claim that it is.** What WUJI adds is a combination: no privileged role
from deployment onward, a finalized-state design with a defined and permissionless response to reorganizations
deeper than the confirmation depth, a derived public value with fixed checkpoints, and per-height bounties from
an immutable reserve.

**Randomness from Bitcoin.** Bentov, Gabizon and Zuckerman (2016) study beacons from Bitcoin under explicit
adversary models. WUJI's per-header rehash does not implement their protocol and does not inherit their security
results.

**Collateralized splits.** Gnosis Conditional Tokens established collateral splitting and merging into
conditional shares. WUJI's paired vault reuses that idea with a fixed index payoff, and the idea is not new.

**Synthetic random markets.** Deriv's synthetic indices are driven by a cryptographically secure random number
generator run by an operator. WUJI's difference is that anyone can recompute the input from public headers and
that settlement rules are enforced by public contracts. WUJI does not claim to be the first random market.

**Succinct verification.** BTCSnarkRelay, zkBridge and others prove header chains with SNARKs. WUJI built and
measured such a path (§9.9) and chose not to depend on it.

---

## 14. Conclusion

WUJI reduces a benchmark to its essentials. It has a public input that costs real work to produce, a rule short
enough to recompute by hand, and an immutable verifier on Ethereum that enforces three explicit rules and has a
definite answer for when Bitcoin reorganizes past it. The perpetual accounts show how claims can settle against
such a path without oracles and without letting claim order allocate losses, and how a miner's incentive to
bias the path can be bounded by a cap tied to Bitcoin's own block subsidy.

What remains is not a question of design but of evidence: independent review, independent operators, observed
full series, and actual use. Until that evidence exists, WUJI is a testnet system, and this paper describes it as
such.

<!-- pagebreak -->

## Appendix A. Parameters

| Name | Value | Kind | Source |
|---|---|---|---|
| `UNIT` | 1.2 × 10¹³ (wad per byte-sum unit) | constant | `WujiHeaderIndex.sol` |
| `MEAN` | 4080 | constant | `WujiHeaderIndex.sol` |
| `POW_LIMIT` | 2²²⁴ − 1 | constant | `WujiHeaderIndex.sol` |
| `RETARGET_INTERVAL` / `TARGET_TIMESPAN` | 2016 / 14 days | constant | `WujiHeaderIndex.sol` |
| `MAX_FUTURE_BLOCK_TIME` | 2 hours | constant | `WujiHeaderIndex.sol` |
| `MAX_SEEN_MTP_LEAD` | 3 hours (source only) | constant | `WujiHeaderIndex.sol` |
| `CONFIRMATIONS` (`K`) | 100 | deployment | Sepolia v3 manifest |
| `REORG_MARGIN` | 144 | constant | `WujiHeaderIndex.sol` |
| `MAX_HEADERS` / `MAX_REORG_HEADERS` / segment | 512 / 800 / 256 | constant | `WujiHeaderIndex.sol` |
| `CHECKPOINT_INTERVAL` (`L`) | 4320 | deployment | Sepolia v3 manifest |
| `GENESIS_HEIGHT` (`G`), Sepolia v3 | 969 546 | deployment | `verification/header-v3/candidate.json` |
| `BOUNTY_DIVISOR` (reserve) | 100 000 | constant | `RelayerRewards.sol` |
| `MAX_TOKENS` / `MAX_HEIGHTS` | 8 / 512 (Sepolia v3: 256) | constant | `RelayerRewards.sol` |
| Pool `K_pool` | 23 / 11.5 / 4.6 | constant | `WujiAccountsFactory.sol` |
| Pool `EPOCH` | 6 heights | deployment | `DeployAccounts.s.sol` |
| Pool `FEE_BPS` | 30 | deployment | `DeployAccounts.s.sol` |
| Pool `BUFFER_BPS` | 1 000 | deployment | `DeployAccounts.s.sol` |
| Pool bounty divisor | 10 000 | constant | `WujiAccountsFactory.sol` |
| `ACCOUNT_BATCH` / `MAX_WALK` | 64 / 1 024 | constant | `WujiAccounts.sol` |
| `MAX_SEEN_AGE` | 24 hours | constant | `WujiAccounts.sol` |
| Cap halving era | 210 000 heights | constant | `WujiAccounts.sol` |

## Appendix B. Test vector

| Field | Value |
|---|---|
| Height | 800 000 |
| `nBits` | `0x17053894` |
| Explorer hash | `00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054` |
| `H` (internal order) | `54a02827d7a8b75601275a160279a3c5768de4c1c4a702000000000000000000` |
| `R = SHA256(H)` | `74323d1b46bfc56d162ea5725ebc666028c5ee2b0a4824e32dedff53fe3ec1fd` |
| `Σ bytes(R)` | 3 893 |
| `d` | −187 |
| `ΔS_wad` | −2 244 000 000 000 000 |
| Mean raw-digest byte sum (uniform valid hash) | 2802.883 |

## Appendix C. Pricing-margin table

`M(b)` is the number of blocks past `seenHeight` for an index whose newest validated header is `b` hours old,
rounded up: the smallest `m` with `P[Poisson(7.5 · (b + 2)) ≥ m] ≤ 10⁻⁷`.

| b (h) | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| M(b) | 40 | 52 | 64 | 74 | 85 | 95 | 105 | 115 | 125 | 135 | 144 | 154 | 163 |

| b (h) | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| M(b) | 173 | 182 | 191 | 201 | 210 | 219 | 228 | 237 | 246 | 255 | 264 | 273 |

## Appendix D. Reproduction

From a full checkout of the repository:

```bash
node scripts/whitepaper-facts.mjs          # byte-order vector, variance, raw-digest mean
node --test indexer/bitcoin.test.mjs       # index arithmetic on real headers
forge test --root contracts                # unit, fuzz, invariant and real-data suites
cd verification/header-v3 && node verify.mjs integrity && node verify.test.mjs
```

The verification kit's `fetch` and `replay` commands download headers from public sources into a new directory
and replay them offline against the fixed Sepolia block. Each external check should be run in an environment
the checker controls, not from cached files supplied by the authors.

## Appendix E. Glossary

- **Anchor**: the trusted header at `G − 1` from which a deployment starts.
- **Continuity**: the finalized state (hash, height, bits, time, epoch start, `u`) that the next header must
  extend.
- **Fold**: validating headers and advancing the finalized state, which adds increments to `U`.
- **Seal**: the permanent stop triggered by Rule 3.
- **Epoch (pool)**: a pricing height, a multiple of 6, at which queued entries and exits are processed.
- **Matched principal**: `min(P_yin, P_yang)`, the part of each side that has a counterparty.
- **Keeper**: anyone who submits headers or processes accounts. The role has no privileges.

## References

1. S. Nakamoto, *Bitcoin: A Peer-to-Peer Electronic Cash System*, 2008.
2. Bitcoin Core, `src/pow.cpp` (`CalculateNextWorkRequired`, `GetBlockProof`), `src/validation.cpp` (header
   checks), and BIP34, BIP65 and BIP66.
3. I. Bentov, A. Gabizon, D. Zuckerman, *Bitcoin Beacon*, arXiv:1605.04559, 2016.
4. Gnosis, *Conditional Tokens* developer guide.
5. EIP-170 (contract code size limit); EIP-7825 (transaction gas limit cap); draft ERC-8002 (SPV gateway).
6. W. Whitt, lecture notes on Brownian motion first passage; MIT 18.675 and 15.070J notes on optional stopping
   and maximal inequalities for non-negative supermartingales.
7. WUJI repository: `docs/ARCHITECTURE.md` (decisions), `docs/THREAT_MODEL.md`, `docs/MAINNET_CHECKLIST.md`,
   `docs/decisions/` (header path, submitter economics, chain choice, pool exposure), `docs/RELATED_WORK.md`.

---

*Licensed under MIT, like the code. This document carries no warranty. It describes software that runs on public
testnets and has not been independently audited.*
