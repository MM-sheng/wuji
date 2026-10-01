# Next tasks (post Bitcoin-source merge, 2026-09-20)

Read `AGENTS.md` and `docs/ARCHITECTURE.md` first. Work top to bottom; each task is one PR unless noted.
The bar for every task: `forge test` green, invariants untouched, nothing gains an owner.

The goal these serve: **the disappearance test** — if the authors vanish, the protocol keeps running.
There is no privileged contract operator, but economic liveness and one-sided exit after a deep reorg remain
unresolved. The keeper, fees, indexer and front-end have not passed the full disappearance drill.

2026-09-22 follow-up: [T8_RECOVERY_REPORT.md](T8_RECOVERY_REPORT.md) records a successful complete v4
two-source replay, recovered wallet-owned test fuel and restored indexer reads. Fuel recovery is partial;
the relay remains stale. [SEPOLIA_V4_HANDOFF.md](SEPOLIA_V4_HANDOFF.md) is ready for an independent
reviewer/operator; the user has confirmed neither is available yet and requested continued local checks.
The original three financial/state handlers then passed ten seeded shards of 100 runs at depth 100 each
(1000 runs per handler, 300000 unique randomized calls), with all original predicates and fail-on-revert intact.

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

Implemented on `codex/bitcoin-timestamps`; delivery and evidence: [T2B_REPORT.md](T2B_REPORT.md).
MTP11, future two-hour bound, mainnet version floors and the three-hour advertised-tip-age gate are in source.
112 Solidity tests and 8 Node tests passed. The separate :8792 testnet deployment passed runtime/binding
checks, live catch-up through Bitcoin 967855, two-asset bounty replay and exact-height index reconciliation.
The age gate does not prove global synchronization. Independent review remains open.

- Implement median-time-past (11-block median; store or walk ancestors — measure gas) and the 2-hour future-time
  limit exactly as Bitcoin Core. Document any remaining omission and why it cannot create work.
- `WujiIndex.fold` must refuse while the relay is still catching up: e.g. require the relay's best-header timestamp
  to be within a bounded distance of `block.timestamp`, so six-deep folding cannot happen on a stale local view.
- Differential tests against more real epochs (at least 3 retargets) and a Core-derived vector set for MTP.

## T3 · Deploy to Ethereum Sepolia with **ETH (WETH) collateral** — this is the mainnet shape (see ARCHITECTURE 目标栈)

Delivered on `codex/sepolia`: [T3_REPORT.md](T3_REPORT.md). Sepolia WETH vault and separate keeper are live
at :8793; seven deployment and seven smoke receipts succeeded. BSC/Sepolia agreed at Bitcoin 967851,
including exact integer S and hash; reserve funding, 26-height bounty allocation and actual claims were
replayed. 112 Solidity tests and 28 Node tests passed; protocol source and original invariants unchanged.
Independent review remains open. The next implementation task is T4.

Same contracts, same `GENESIS_HEIGHT`, same relay checkpoint, deployed on Sepolia (chain 11155111). Run a second
keeper against it. Add `scripts/compare-chains.mjs` that reads `S`, `lastHeight`, `lastHash` from both the BSC-testnet
and Sepolia indexes and prints whether they agree at the same height (they must while neither has frozen). Document
in ARCHITECTURE §1 as "a shared settlement index; each deployment is a separate claim" — not "one asset". and add the Sepolia addresses to `contracts/deployments/`.
Sepolia ETH comes from a faucet; do not ask for keys — the keystore flow already exists (`set-key.sh`, use a second
account name).

## T4 · Anyone can verify, anyone can run

Implemented on `codex/independent-verification`: [T4_REPORT.md](T4_REPORT.md). Independent two-source
reconstruction, read-only credential mounts, reproducible runtime checks and offline CI integration are delivered.
112 Solidity tests and 58 Node tests passed, with invariants unchanged. Sepolia's seven runtimes match the fresh
reproducible build. The original v3 live attempts failed on public-API 429s. A later complete v4 replay passed
at pinned EVM block 11757099 ([recovery report](T8_RECOVERY_REPORT.md)); no checkpoint was due, and
operator/audit acceptance remains open. T5's implementation followed this task.

- `scripts/wuji-verify.mjs`: one command, no dependencies, that (a) fetches the headers from `GENESIS_HEIGHT` to the
  contract's `lastHeight` from two independent Bitcoin sources, (b) recomputes U/S exactly as the contract, (c) reads
  the contract's `S` and `checkpointS` values, (d) prints PASS/FAIL per checkpoint. This is the artefact a stranger runs
  before trusting the number on the screen.
- `Dockerfile` + `docker-compose.yml` for indexer + keeper (env-driven, keystore mounted read-only). README section
  "Run your own indexer / keeper in five minutes".
- Reproducible build: pin `solc` version and settings in `foundry.toml`; `scripts/verify-bytecode.sh` compares the
  deployed runtime bytecode (immutables masked) with a fresh local build. Add to CI.

## T5 · Terminal for a 10-minute heartbeat + IPFS

Implemented on `codex/terminal-ipfs`: [T5_REPORT.md](T5_REPORT.md). Staircase view, persisted source selection,
fresh browser RPC comparison, read-only CORS and verified single-file IPFS pinning are delivered. 112 Solidity
and 74 Node tests pass. Live Sepolia snapshot comparison and the offline IPFS gateway flow were verified.
Public persistent hosting/DNS remain unconfigured; T4's full live two-source snapshot later passed for v4.
T6's whitepaper and T7's design-stage delivery follow below.

- The market now steps every ~10 min. Make that legible: last Bitcoin height and hash (→ mempool.space), time since
  last block, next-block ETA from mempool fee/stat endpoints, the current series boundary height with blocks-to-go,
  and the on-chain S vs indexer S badge as today. Candles stay; add a "steps" line-style that draws the path as a
  staircase.
- Indexer source selector (URL list, persisted); client-side `eth_call` cross-check of `S` and `yangShare` against the
  configured RPC so the indexer is never the only voice.
- `scripts/publish-ipfs.sh`: pins `apps/terminal/` (single file, no build) and prints the CID. Document the
  `wuji.market` → IPFS gateway / DNSLink setup for when the domain exists.

## T6 · Whitepaper

Delivered on `codex/whitepaper`: [T6_REPORT.md](T6_REPORT.md). The Chinese Markdown and six-page PDF cover the
current implementation, conditional model, preregistration method and related work. Offline facts come from
contract constants, public manifests and real fixtures. 112 Solidity tests and the three Bitcoin JS tests pass;
protocol code and financial invariants are unchanged. This is a research whitepaper, not an independent audit.
T7's design-stage delivery follows below; rolling contract implementation remains subject to review.

`docs/WHITEPAPER.md`, ≤ 6 pages, in this order: (1) 无极生太极，太极生两仪 — what it is in one paragraph;
(2) the path: Bitcoin PoW, byteSum, UNIT, why re-hash, expected vol; (3) the pair: absolute-position clamped settlement shares, expiry payoffs versus market prices, bounded claims and series; (4) collateral vaults and the factory; (5) settlement
on deterministic heights; (6) what can go wrong: miner bias cost, deep reorgs, relay checkpoint trust, data-source
liveness, collateral risk (USDT freeze vs WBNB); (7) the "never" list: no token, no governance, no admin, no upgrade,
no pause, no foundation; (8) how to verify (T4). Numbers must come from the code and tests, not prose. Bilingual is
welcome: Chinese primary, English full translation. Include the preregistered benchmark method and related work
outlined in WUJI_FOUNDATIONS §§9–10; do not inherit other beacon protocols’ security proofs.

## T7 · Rolling vault — REDESIGN before building (review item #9)

Design-stage delivery on `codex/rolling-design`: [T7_DESIGN.md](T7_DESIGN.md), [T7_REPORT.md](T7_REPORT.md).
All 36 specified historical replay scenarios are recorded, including unpriced incomplete positions. The existing
fixture provides only one full 4320-height series; shorter cases are hypothetical stress comparisons. 112 Solidity
and 84 Node tests pass. The recommendation is to defer a rolling token; no application contract is implemented
or approved. The next protocol task is T9, while any T7 implementation still requires design review.

One-for-one conversion is an accounting error. Even **value-correct** full reinvestment at the hypothetical
entry price N/2 has per-series wealth factor `2·g(X)`, negative expected log growth and, under the stated model,
a nonzero probability of total loss. Any rolling product must (a) re-enter by **value** (0.8·N of old YANG buys 1.6
new YANG at ½), (b) be documented as a rolled-derivative strategy with its NAV process stated, and (c) never be drawn
as one continuous price history. Write the design note first (`docs/tasks/T7_DESIGN.md`) with the NAV math and a
simulation over the real header fixtures; build only after review. It may turn out that no rolling token should exist.

## T9 · Frozen-state exit (review item #7) — required before mainnet

Source candidate delivered on `codex/frozen-exit`: [T9_DESIGN.md](T9_DESIGN.md), [T9_REPORT.md](T9_REPORT.md).
It adds revision-bound observation, a 144-height test-candidate delay, irreversible index sealing and per-vault
closure at the recorded own boundary or 1/2. Paired exits, fees and original financial invariants are preserved.
134 Foundry tests and 84 Node tests pass; the new terminal-state handler also passed 100000 randomized calls.
Existing v3 deployments have no such path. Client/keeper integration and a 22-transaction local exit drill
are delivered ([integration report](T9_INTEGRATION_REPORT.md)). The separate Sepolia v4 release is deployed;
live acceptance and receipts are tracked in [the deployment report](T9_SEPOLIA_V4_REPORT.md). Review, public
MetaMask verification and the real operator drill remain pending; the economic parameter decision and mainnet
gate remain open. No mainnet readiness is claimed.

A Bitcoin reorg replacing a folded hash makes `fold` reject progress while that mismatch persists; there is no
rollback/recomputation mechanism for the replacement branch. Matched pairs remain redeemable less fees under
ordinary collateral behaviour, but an unmatched holder may have no single-sided exit before settlement.
Design and implement a rule with no admin: if `fold` has been halted for more than X Bitcoin blocks (measured by the
relay's own best height, not wall clock), the current series settles at the **last recorded checkpoint** (or, if none
in this series, at ½/½) and no further series opens for that vault. Analyse and test the incentive to trigger the halt
deliberately (who gains at which state) and choose X accordingly. Write-up in THREAT_MODEL.

## T8 · Operations before mainnet (not code-heavy, but required)

Runtime preparation: [T8_KEEPER_RUNTIME.md](T8_KEEPER_RUNTIME.md) removes slow per-read Foundry capability
probes, checks pending work and fuel before signing, and records a live v4 update after the change. This is
author-operated evidence; the independent-machine, 48-hour and first-settlement requirements below remain open.
The v3 comparison keeper is currently stopped for insufficient test fuel; its read-only indexer remains available.

- ✅ **Own Bitcoin source, no third party** (2026-09-23): `indexer/bitcoin-p2p.mjs` syncs the header chain
  straight from the Bitcoin P2P network (DNS seeds, version/verack handshake, `getheaders`), validating every
  header locally with the same rules as `BitcoinRelay.sol` — PoW against nBits, parent linkage, retarget with
  the ×4/÷4 clamp — and choosing forks by cumulative work. 968,277 headers, 77 MB, 24 minutes; height 800000's
  hash/R/delta and all 2028 committed fixture headers matched byte for byte. Enable with `BITCOIN_SOURCE=p2p`.
  This replaces the plan to run a pruned Bitcoin Core node: a pruned node still downloads ~700 GB to validate
  blocks we never look at, while the protocol only ever reads headers.
  Evidence it was needed: on 2026-09-23 the keeper stalled for an hour because blockstream.info was hard
  rate-limited and mempool.space had entered backoff — both cooldowns exceeded the per-request budget.
  Remaining: run the live stack on it, and document it in the "run your own" section (T4).
- Second keeper on a different machine and RPC provider (T4's Docker makes this trivial).
- **Disappearance drill** (review item #14): switch off every author-run node, RPC, keeper and front-end for 48 h on
  testnet; record whether independent participants take over profitably and whether a one-sided holder can exit.
- THREAT_MODEL rewritten around **attacker private cost** (pool cost-shifting, brief withholding, existing forks) and
  a stated **value-at-risk cap**: with s = 0.5 %/block, a feasible withholding strategy profits once net one-sided
  exposure A > ≈ 501 · c_b in its simplified model (c_b = attacker's private cost per discarded block). Publish
  assumptions and a conservative exposure policy; this is not a proven safe TVL cap (review items #5, #6, #16).
- ✅ **Watchdog and alerts** (2026-09-24): `scripts/watchdog.mjs` restarts an unreachable indexer or a silent
  keeper (rate limited to 4/hour), and alerts on: the indexer falling behind the Bitcoin tip, a source error,
  a halt after a deep reorg, `liabilities > balance`, an overdue settlement, and — the one that is never
  normal — contract `S` disagreeing with the locally recomputed `S` at the same height. `ALERT_COMMAND`
  receives the message on stdin. Five tests drive it against a fake `/head`.
  The protocol does not need this; *observing* a stack for weeks does. Both outages it exists for were real:
  an hour stalled behind rate-limited APIs (2026-09-23) and a process killed by one silent Bitcoin peer
  (2026-09-24).
- Let the first real 30-day series (boundary height 972145) settle on testnet untouched; write up what happened.
- Then: independent audit of the exact release commit; bug bounty; `docs/MAINNET_CHECKLIST.md` fully ticked.

## T10 · ZK relay — Groth16 verified on chain (2026-09-29); keeper automation and public deployment remain

A real Groth16 proof of 100 mainnet headers verifies against SP1's unmodified v6.1.0 verifier: 453,888 gas
for the batch vs 1,928,070 on the header path (`contracts/test/ZkWujiGroth16.t.sol`, details in
T10_DESIGN.md). Remaining: keeper proves and submits batches (falls back to headers); deploy on Sepolia with
the real verifier; best-height source for T11 pools on a ZK index.

### History

Design: [T10_DESIGN.md](T10_DESIGN.md). The decision that shapes it: the guest proves **the index
increment**, not only chain validity, so `submit` and `fold` collapse into one call whose cost does not
grow with the batch.

Done:
- `zk/wuji-header-core` — rules + accumulator in Rust, no zkVM dependency. 6060 real mainnet headers over
  4 retargets reproduce `U = 6888` and `S_wad = 82656000000000000`, identical to Solidity and JS.
- `contracts/src/ZkWujiIndex.sol` — `foldProof` (one proof per batch) and `foldHeaders` (raw headers in
  Solidity, the escape hatch) advancing one state machine. 10 differential tests: both paths reach the
  same S, height, hash, work and median-time-past window over real headers, and interleave freely.
  Measured: ≈19k gas **per header** on the header path vs **86k for 256 heights** on the proof path
  (verifier excluded). (First recorded as 99k per header; that included the test's own header copying.) Runtime size 10,779 bytes.
- `zk/program`, `zk/script` — SP1 guest and host written.

Two design corrections found while building, both now in the code and its comments:
1. Continuity is carried from `tip − CONFIRMATIONS`, never from the validated tip. Otherwise a reorg
   shallower than the confirmation depth orphans the committed state and the index is stuck — the exact
   failure confirmations exist to prevent.
2. Solidity memory structs alias on assignment; the snapshot is copied field by field. An aliased
   snapshot would silently have committed the tip and defeated the confirmation depth.

Measured (SP1 v6.8, 14-core M-series, 64 GB):

| headers | cycles | cycles/header | execute | compressed proof |
|---:|---:|---:|---:|---:|
| 100 | 2,833,099 | 28.3k | 46 ms | 44.4 s |
| 500 | 13,769,507 | 27.5k | 199 ms | — |

Cycles are linear at ~27.5k per header, so a 4320-header month is ≈119M cycles. In every run the
guest's committed journal is byte-identical to the host's, computed by the same `wuji-header-core` the
Solidity path is differential-tested against. A compressed proof verifies locally; `vkey`
`0x005bcc55d50f7f92d73f3869b71be8ff0ec500bfd58b484517106e52b613e2e8` for the current guest.

Remaining:
- Groth16 wrap (the on-chain format). Root cause of the two failures: SP1 fetches a **6.2 GB** artifact
  tarball and needs about as much again to extract it; this machine had 6.3 GB free, and SP1's installer
  deletes its staging directory on any interruption, so it can never make progress. Run it somewhere with
  ~15 GB free and a stable link, then record the real verifier gas. The proving pipeline itself is already
  demonstrated by the compressed proof; Groth16 changes only the wrapper.
- Interop test: decode a host-produced journal in Foundry to prove the ABI encodings agree.
- Keeper: prove and submit, falling back to `foldHeaders` when proving is unavailable.
- THREAT_MODEL: the zkVM verifier joins the trusted base — state it plainly. A broken *prover* cannot
  stop the protocol (escape hatch); a broken *verifier* could corrupt it.
- Deploy to a testnet and reconcile against the non-ZK deployment.
---

## T12 · Challenge window for ZK folds — live on Sepolia (2026-10-01)

Design, build notes, measurements and deployment: [T12_CHALLENGE_WINDOW.md](T12_CHALLENGE_WINDOW.md).
`0x0ee930Fe689a29Fde478a5fE995e17AE0Fd06B47`; keeper and watcher running. Remaining: a second watcher machine,
independent review.

## Explicitly not now

- Changing the pair rule, fee rate, series length, confirmations or UNIT.
- Any governance, multisig, timelock or "emergency" function. The answer to "what if X" is a rule in the contract
  or a documented accepted risk, never a key.
- Renaming: WUJI / μ are final (`docs/NAMING.md`).

## T11 · Perpetual accounts — built, live on BSC testnet

The answer to "a holding that never expires". Fixed principal, additive P&L recorded on chain
(`principal·ΔS/k`, floor 0, ceiling 2×), fixed vol-tier menu, entry/exit priced at a not-yet-mined Bitcoin
block, ETH and wstETH/rETH collateral, frozen exit on indexes that have one. Supersedes T7 (rolling vault).
Design and build log: `docs/tasks/T11_PERPETUAL_ACCOUNTS.md`; risks: `docs/THREAT_MODEL.md` §T11.

Open:
- [ ] Wallet actions in the terminal tested by a person with a real wallet (BSC testnet).
- [ ] Sepolia deployment on the v4 index (needs Sepolia ETH for the deployer; exercises the frozen exit).
- [ ] ZkWujiIndex: source of the best Bitcoin height for request scheduling (options in the design doc).
- [ ] Independent audit of `WujiAccounts` / `WujiAccountsFactory` before any mainnet deployment.
