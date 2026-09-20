# Next tasks (post Bitcoin-source merge, 2026-09-20)

Read `AGENTS.md` and `docs/ARCHITECTURE.md` first. Work top to bottom; each task is one PR unless noted.
The bar for every task: `forge test` green, invariants untouched, nothing gains an owner.

The goal these serve: **the disappearance test** — if the authors vanish, the protocol keeps running.
There is no privileged contract operator, but economic liveness and one-sided exit after a deep reorg remain
unresolved. The keeper, fees, indexer and front-end have not passed the full disappearance drill.

---

## T0 · Claims correction (docs + terminal wording) — implemented, awaiting review

Delivery and verification: [T0_REPORT.md](T0_REPORT.md). No contract or financial-test changes in this task.

Source: `docs/reviews/2026-09-20-adversarial.md` (read it in full). Apply every "动作" marked as documentation:
- Positioning: WUJI is **a verifiable pure-randomness settlement market and public benchmark**, not a zero-beta hedge,
  not crisis collateral, not "an asset like Bitcoin". Remove those claims from ARCHITECTURE §0, README, NAMING subtitle
  (new subtitle: *A market about nothing. Verifiable. Heartbeat: Bitcoin.*).
- Four concepts, never conflated: **index S** / **instantaneous settlement share** `clamp(½+½ΔS)` / **payoff at
  expiry** / **market price**. The share is absolute-position, path-independent; drop the word "唯一" and the "每块转移"
  wording. State explicitly: the share is not a price and must never be used as a lending-collateral price feed.
- Delete every σ²/8 / "再平衡收割" / "没有知情者" / "无毒流" / "一个 WUJI 多个场所" statement. Replace the last with
  "shared settlement index, a family of separate claims".
- Solvency invariant stated as a theorem under standard ERC-20 behaviour assumptions; arbitrary-token vaults carry no
  equal-safety promise.
- Terminal: label `values()` output as "settlement share (not price)"; never draw series resets as one continuous
  history; add the 4-concept note to the About tab.

## T1 · Protocol pays its own keepers — `RelayerRewards` + `FeeRouter` (highest priority, changes contracts, must land before audit)

Current rework: [T1_RESERVE_REPORT.md](T1_RESERVE_REPORT.md), branch `codex/operations-reserve`.
One-off reserve bounties and atomic submit/fold are implemented; 92 Solidity tests and 4 Node tests passed.
The new :8791 deployment passed eight mock mint/redeem/route transactions, live 15-height bounty/claim replay,
bytecode/binding verification and exact-height index reconciliation; receipts are in the report. Independent review remains pending.
The earlier [T1_REPORT.md](T1_REPORT.md) describes the superseded lifetime-points testnet.

**Rework required after the 2026-09-20 review (items #12, #13, #21) before merge:**
- **No burn.** 100 % of fees go to an immutable **operations reserve** that can only be paid out as keeper bounties.
  Burning collateral pays nobody and ERC-20 has no uniform burn.
- **Per-task bounties instead of perpetual points.** Each *finalised* height (its header accepted and later folded)
  pays a one-off bounty to the account that folded it (folding is the act that proves the header stayed on the main
  chain). Bounty = a fixed fraction of the reserve balance per height (e.g. 1/10 000 of the balance in that token), so
  it self-scales with what the protocol earns and never runs dry. No historical points sharing future income; no
  claim() of old work against new fees.
- Per-asset accounting; anyone may `fund(token, amount)` the reserve (the deployer will pre-fund at launch — that is
  a donation, not a privilege).
- Update WujiVault NatSpec to the four-concept terminology without changing payoff rules; T0 deliberately leaves Solidity source untouched.
- Add the economic model to ARCHITECTURE §4: gas per finalised height (measure), bounty per height at a given reserve
  balance, and the primary-market volume needed to sustain it on BSC and on Ethereum at stated gas prices.

Problem: relaying headers and folding costs gas; today one machine does it for free. Nobody else has a reason to.

Original build brief (historical; superseded by the rework requirements above):
- `FeeRouter` (immutable): becomes every vault's `treasury`. On receipt of any ERC-20 fee it splits by a constant
  ratio, e.g. `REWARD_BPS = 5000` to `RelayerRewards`, the remainder to `0x000…dEaD` (burn). Pull-based: anyone may
  call `route(token)` to forward the router's balance; vaults keep paying the router with plain `safeTransfer`.
- `RelayerRewards` (immutable): points-based reward distributor over arbitrary ERC-20s (one accumulator per token,
  MasterChef-style `accPerPoint`, no loops over users). Points are credited only by `BitcoinRelay` (per header that
  becomes part of the relay's main chain — not for known/duplicate headers, not for orphans) and by `WujiIndex` (per
  height folded). `claim(token)` pays the caller's share. No admin, no parameters after deployment.
- `BitcoinRelay` / `WujiIndex`: take the rewards address as an immutable constructor arg; credit points in
  `submit`/`fold`. Predict addresses in the deploy script (CREATE nonces) to break the constructor cycle — no
  `setRewards` function.
- Tests: fee split exactness (rounding dust stays in the router, never lost), points only for main-chain headers,
  claim math with multiple tokens and multiple relayers, invariant "router + rewards + burn == fees paid".
- Docs: ARCHITECTURE §4 (fee destination is now decided: 50 % relayers / 50 % burn — if you choose different
  numbers, say why), THREAT_MODEL (griefing: submitting orphan headers earns nothing; a relayer front-running
  another's batch is fine — the header is accepted once, whoever mines first is paid).
- Redeploy testnet with the router as treasury. Record addresses.

## T2 · Relay storage packing (gas)

Compact storage implementation and controlled measurements: [T2_REPORT.md](T2_REPORT.md), branch `codex/relay-packing`.
Measured steady/new-worker reward batches are 68069/69919 gas per header; first-retarget initialization is higher.
Regression tests enforce the steady-batch and whole-fixture targets. See the report for review/deployment status.

`submit` is 103k gas/header; target ≤ 70k. Pack `Node` into two slots (parent hash; then work as `uint128` —
Bitcoin's total work fits comfortably — height `uint32`, time `uint32`, bits `uint32`, epochTime `uint32`, known
`bool`). Keep `main[height]`. Do not remove any validation. Report a before/after gas table; fixtures must still pass
byte-for-byte.

## T2b · Relay: complete header validation and a catch-up gate (review item #4)

- Implement median-time-past (11-block median; store or walk ancestors — measure gas) and the 2-hour future-time
  limit exactly as Bitcoin Core. Document any remaining omission and why it cannot create work.
- `WujiIndex.fold` must refuse while the relay is still catching up: e.g. require the relay's best-header timestamp
  to be within a bounded distance of `block.timestamp`, so six-deep folding cannot happen on a stale local view.
- Differential tests against more real epochs (at least 3 retargets) and a Core-derived vector set for MTP.

## T3 · Deploy to Ethereum Sepolia with **ETH (WETH) collateral** — this is the mainnet shape (see ARCHITECTURE 目标栈)

Same contracts, same `GENESIS_HEIGHT`, same relay checkpoint, deployed on Sepolia (chain 11155111). Run a second
keeper against it. Add `scripts/compare-chains.mjs` that reads `S`, `lastHeight`, `lastHash` from both the BSC-testnet
and Sepolia indexes and prints whether they agree at the same height (they must while neither has frozen). Document
in ARCHITECTURE §1 as "a shared settlement index; each deployment is a separate claim" — not "one asset". and add the Sepolia addresses to `contracts/deployments/`.
Sepolia ETH comes from a faucet; do not ask for keys — the keystore flow already exists (`set-key.sh`, use a second
account name).

## T4 · Anyone can verify, anyone can run

- `scripts/wuji-verify.mjs`: one command, no dependencies, that (a) fetches the headers from `GENESIS_HEIGHT` to the
  contract's `lastHeight` from two independent Bitcoin sources, (b) recomputes U/S exactly as the contract, (c) reads
  the contract's `S` and `checkpointS` values, (d) prints PASS/FAIL per checkpoint. This is the artefact a stranger runs
  before trusting the number on the screen.
- `Dockerfile` + `docker-compose.yml` for indexer + keeper (env-driven, keystore mounted read-only). README section
  "Run your own indexer / keeper in five minutes".
- Reproducible build: pin `solc` version and settings in `foundry.toml`; `scripts/verify-bytecode.sh` compares the
  deployed runtime bytecode (immutables masked) with a fresh local build. Add to CI.

## T5 · Terminal for a 10-minute heartbeat + IPFS

- The market now steps every ~10 min. Make that legible: last Bitcoin height and hash (→ mempool.space), time since
  last block, next-block ETA from mempool fee/stat endpoints, the current series boundary height with blocks-to-go,
  and the on-chain S vs indexer S badge as today. Candles stay; add a "steps" line-style that draws the path as a
  staircase.
- Indexer source selector (URL list, persisted); client-side `eth_call` cross-check of `S` and `yangShare` against the
  configured RPC so the indexer is never the only voice.
- `scripts/publish-ipfs.sh`: pins `apps/terminal/` (single file, no build) and prints the CID. Document the
  `wuji.market` → IPFS gateway / DNSLink setup for when the domain exists.

## T6 · Whitepaper

`docs/WHITEPAPER.md`, ≤ 6 pages, in this order: (1) 无极生太极，太极生两仪 — what it is in one paragraph;
(2) the path: Bitcoin PoW, byteSum, UNIT, why re-hash, expected vol; (3) the pair: absolute-position clamped settlement shares, expiry payoffs versus market prices, bounded claims and series; (4) collateral vaults and the factory; (5) settlement
on deterministic heights; (6) what can go wrong: miner bias cost, deep reorgs, relay checkpoint trust, data-source
liveness, collateral risk (USDT freeze vs WBNB); (7) the "never" list: no token, no governance, no admin, no upgrade,
no pause, no foundation; (8) how to verify (T4). Numbers must come from the code and tests, not prose. Bilingual is
welcome: Chinese primary, English full translation. Include the preregistered benchmark method and related work
outlined in WUJI_FOUNDATIONS §§9–10; do not inherit other beacon protocols’ security proofs.

## T7 · Rolling vault — REDESIGN before building (review item #9)

The naive roll (settle, re-enter 1:1) has a negative log drift: per-series wealth factor `2·g(X)` has E[log] < 0 and
a nonzero probability of total loss. Any rolling product must (a) re-enter by **value** (0.8·N of old YANG buys 1.6
new YANG at ½), (b) be documented as a rolled-derivative strategy with its NAV process stated, and (c) never be drawn
as one continuous price history. Write the design note first (`docs/tasks/T7_DESIGN.md`) with the NAV math and a
simulation over the real header fixtures; build only after review. It may turn out that no rolling token should exist.

## T9 · Frozen-state exit (review item #7) — required before mainnet

A >6-block Bitcoin reorg halts `fold` forever; pairs still redeem at par but a one-sided holder has no exit.
Design and implement a rule with no admin: if `fold` has been halted for more than X Bitcoin blocks (measured by the
relay's own best height, not wall clock), the current series settles at the **last recorded checkpoint** (or, if none
in this series, at ½/½) and no further series opens for that vault. Analyse and test the incentive to trigger the halt
deliberately (who gains at which state) and choose X accordingly. Write-up in THREAT_MODEL.

## T8 · Operations before mainnet (not code-heavy, but required)

- Second keeper on a different machine and RPC provider (T4's Docker makes this trivial).
- **Disappearance drill** (review item #14): switch off every author-run node, RPC, keeper and front-end for 48 h on
  testnet; record whether independent participants take over profitably and whether a one-sided holder can exit.
- THREAT_MODEL rewritten around **attacker private cost** (pool cost-shifting, brief withholding, existing forks) and
  a stated **value-at-risk cap**: with s = 0.5 %/block, a feasible withholding strategy profits once net one-sided
  exposure A > ≈ 501 · c_b in its simplified model (c_b = attacker's private cost per discarded block). Publish
  assumptions and a conservative exposure policy; this is not a proven safe TVL cap (review items #5, #6, #16).
- Alerts: relay lag > 3 Bitcoin blocks, index backlog, keeper errors, `liabilities > balance` (should be impossible —
  alert anyway), settlement overdue.
- Let the first real 30-day series (boundary height 972145) settle on testnet untouched; write up what happened.
- Then: independent audit of the exact release commit; bug bounty; `docs/MAINNET_CHECKLIST.md` fully ticked.

## T10 · ZK-SPV relay — verify a month of Bitcoin headers in one proof (after T2b; makes Ethereum L1 affordable)

Goal: replace per-header on-chain verification (≈16.6M gas/day, ~$50/day on L1 at 1 gwei) with one succinct proof
per batch (≈300k gas regardless of batch size, ~$1/month). This is what makes the target stack (Bitcoin source,
Ethereum L1 settlement, ETH collateral) run on zero budget.

Design (write `docs/tasks/T10_DESIGN.md` first, build after review):
- **Guest program** (zkVM: SP1 or RISC Zero — pick by proving cost, verifier gas and audit surface; cite the existing
  Bitcoin header-chain examples/ZeroSync as prior art) that takes a starting header state (hash, height, bits,
  epoch-start time, cumulative work) and N raw headers, and re-implements **exactly** `BitcoinRelay`'s rules: sha256d
  ≤ target, parent linkage, retarget with clamp and compact encoding, MTP and future-time limits (from T2b), work
  accumulation. Output: final state + a commitment to every header hash in the batch (Merkle root, so `/proof` and
  `fold` can address individual heights).
- **`ZkBitcoinRelay` contract**: stores the trusted checkpoint state; `submitProof(proof, newState, headersRoot)`
  verifies with the zkVM's on-chain verifier and advances the main chain. Fork choice stays work-based: a proof
  extending an older state with more cumulative work replaces the tip; six-deep folding unchanged. Individual
  header hashes become available to `WujiIndex` via Merkle proofs (or the proof output includes the hashes for the
  finalised range directly — measure calldata cost vs storage).
- **Fallback path**: keep the per-header `submit` as an escape hatch so liveness never depends on any prover; both
  paths must yield identical state (differential test).
- **Prover**: off-chain, anyone; the keeper generates the proof on a normal machine (report CPU time and RAM for a
  4320-header batch) or uses a prover network. No trusted setup beyond the zkVM's; document the zkVM's own trust
  assumptions (circuit soundness, verifier contract immutability) in THREAT_MODEL — this is the one new trust
  element and must be stated plainly.
- Tests: the existing real-header fixtures through both paths; retarget inside a batch; a batch that crosses a
  checkpoint height; invalid header inside a batch must fail to prove.
- Report: gas per batch, proving time/cost, and the new monthly cost table for Ethereum L1, BSC and one L2.

Zero-budget path until T10 lands: stay on BSC testnet; first mainnet on a cheap venue (BSC or an Ethereum L2 —
with Bitcoin as the source a sequencer can only delay, not bias) paid by volunteer keepers; move the canonical
deployment to Ethereum L1 once T10 makes it ~$1/month.

---

## Explicitly not now

- Changing the pair rule, fee rate, series length, confirmations or UNIT.
- Any governance, multisig, timelock or "emergency" function. The answer to "what if X" is a rule in the contract
  or a documented accepted risk, never a key.
- Renaming: WUJI / μ are final (`docs/NAMING.md`).
