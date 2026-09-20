# Next tasks (post Bitcoin-source merge, 2026-09-20)

Read `AGENTS.md` and `docs/ARCHITECTURE.md` first. Work top to bottom; each task is one PR unless noted.
The bar for every task: `forge test` green, invariants untouched, nothing gains an owner.

The goal these serve: **the disappearance test** — if the authors vanish, the protocol keeps running.
Today the contracts pass it; the keeper, fees, indexer and front-end do not.

---

## T1 · Protocol pays its own keepers — `RelayerRewards` + `FeeRouter` (highest priority, changes contracts, must land before audit)

Implementation and testnet verification: [T1_REPORT.md](T1_REPORT.md), branch `codex/relayer-rewards`.
Header rewards are intentionally credited at six-deep folding, rather than immediately at submission, to exclude transient orphan branches. Review/merge and independent audit remain pending.

Problem: relaying headers and folding costs gas; today one machine does it for free. Nobody else has a reason to.

Build:
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

Two-slot implementation and controlled measurements: [T2_REPORT.md](T2_REPORT.md), branch `codex/relay-packing`.
The 70k target remains OPEN: rewards-enabled submit is 100612 gas/header; no new deployment yet.

`submit` is 103k gas/header; target ≤ 70k. Pack `Node` into two slots (parent hash; then work as `uint128` —
Bitcoin's total work fits comfortably — height `uint32`, time `uint32`, bits `uint32`, epochTime `uint32`, known
`bool`). Keep `main[height]`. Do not remove any validation. Report a before/after gas table; fixtures must still pass
byte-for-byte.

## T3 · Prove "one WUJI": deploy to Ethereum Sepolia and show identical S

Same contracts, same `GENESIS_HEIGHT`, same relay checkpoint, deployed on Sepolia (chain 11155111). Run a second
keeper against it. Add `scripts/compare-chains.mjs` that reads `S`, `lastHeight`, `lastHash` from both the BSC-testnet
and Sepolia indexes and prints whether they agree at the same height (they must). Document in ARCHITECTURE §1
("the path is Bitcoin's; chains are settlement venues") and add the Sepolia addresses to `contracts/deployments/`.
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
(2) the path: Bitcoin PoW, byteSum, UNIT, why re-hash, expected vol; (3) the pair: fixed-base transfer rule, why it is
the only rule that keeps the pair whole, bounded claims, series; (4) collateral vaults and the factory; (5) settlement
on deterministic heights; (6) what can go wrong: miner bias cost, deep reorgs, relay checkpoint trust, data-source
liveness, collateral risk (USDT freeze vs WBNB); (7) the "never" list: no token, no governance, no admin, no upgrade,
no pause, no foundation; (8) how to verify (T4). Numbers must come from the code and tests, not prose. Bilingual is
welcome: Chinese primary, English full translation.

## T7 · Rolling perpetual vault — `WUJI` / `YIN` tokens (after T1)

An ERC-4626-style vault per collateral that holds the current series' YANG and, at settlement, redeems and re-enters
the next series (mirror vault for YIN; the two roll jointly by minting pairs against each other, only the imbalance
touches the market). Its share token is the thing exchanges list. Same rules: no owner, no upgrade. Spell out the NAV
path in docs (it is not `100·e^S`; see ARCHITECTURE §3). Invariant: vault shares are always fully backed by YANG (or
YIN) + collateral dust.

## T8 · Operations before mainnet (not code-heavy, but required)

- Second keeper on a different machine and RPC provider (T4's Docker makes this trivial).
- Alerts: relay lag > 3 Bitcoin blocks, index backlog, keeper errors, `liabilities > balance` (should be impossible —
  alert anyway), settlement overdue.
- Let the first real 30-day series (boundary height 972145) settle on testnet untouched; write up what happened.
- Then: independent audit of the exact release commit; bug bounty; `docs/MAINNET_CHECKLIST.md` fully ticked.

---

## Explicitly not now

- Changing the pair rule, fee rate, series length, confirmations or UNIT.
- Any governance, multisig, timelock or "emergency" function. The answer to "what if X" is a rule in the contract
  or a documented accepted risk, never a key.
- Renaming: WUJI / μ are final (`docs/NAMING.md`).
