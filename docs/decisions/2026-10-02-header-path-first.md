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
