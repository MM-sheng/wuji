# T11 design: perpetual accounts (只押本金、链上记账)

Status: steps 1–4 built (see end); step 5 (testnet deployment) not started. It is a **new contract** beside the existing series
vaults; it reuses `WujiIndex` / `ZkWujiIndex`, `BitcoinRelay`, `RelayerRewards` and the P2P source unchanged.

## Why

The goal is a holding that behaves like gold or BTC in one respect: **it never expires and nobody has to do
anything to keep it.** The series vaults cannot give that:

- A bounded, fully collateralised claim on an unbounded random walk `S` must saturate: over enough time
  `yangShare = clamp(½ + ½ΔS)` hits 0 or 1 and stays there. That is why series end.
- Rolling series (re-entering at each boundary) do not decay because of rolling; they pay **volatility
  drag** `σ²/2` per year because each series is multiplicative on the previous one. At today's sensitivity
  (annual vol ≈115%) the median holding falls to ≈0.31× per year.

Both problems disappear if P&L is **recorded additively against a fixed principal** instead of compounded.

## The account

```
struct Account {
  address owner;        // transferable (heirs, sale by private agreement)
  uint8   side;         // YANG (+ΔS) or YIN (−ΔS)
  uint8   tier;         // index into a fixed menu of k
  uint128 principal;    // collateral units, or collateral shares for yield vaults
  int256  entryAcc;     // side accumulator at entry (see Pool accounting)
}
```

Value of an account at folded index `S`:

```
pnl   = principal · side · (S − S_entry) / k
value = clamp(principal + pnl, 0, 2 · principal)
```

- **Additive, not compounding** → zero volatility drag; the *median* value stays at principal forever.
- **Floor 0**: nobody ever owes more than they deposited, there is no liquidation and no margin call.
- **Ceiling 2×principal**: symmetric with the floor, so every unit of one side's gain is exactly a unit of
  the other side's loss.
- **No expiry.** An account exists until its owner exits or it reaches the floor.
- Not a fungible token. Price-discovery of a token adds nothing to a random index and brings back the
  front-running problem below. Wrappers (ERC-20 cohorts, lending collateral) can be built by third parties
  on top of transferable accounts; they are not in core.

## Volatility tiers

`S` has a constant, known volatility (σ ≈ 0.5017% per block, ≈115% per year), so dividing by `k` targets an
exact annual vol. A small fixed menu keeps liquidity in few pools; a free slider would split it.

| tier | k    | annual vol | 1-day sd | floor touched within 10y / 30y / 50y |
|------|------|-----------:|---------:|-------------------------------------:|
| 5%   | 23.0 | 5%         | 0.26%    | ~0% / 0.03% / 0.5%                   |
| 10%  | 11.5 | 10%        | 0.52%    | 0.16% / 6.8% / 15.7%                 |
| 25%  | 4.6  | 25%        | 1.31%    | 20.6% / 46.5% / 57.2%                |

(Touch probability = `2·Φ(−1/(v√T))`, the reflection principle for a driftless walk hitting ±principal.)
High-vol tiers for short-term users can be added to the menu at deployment; the menu is immutable after.

## Collateral

Two vault families, deployed side by side, each with its own tiers:

- **ETH (WETH)** — nothing but the index moves the value.
- **wstETH / rETH** — non-rebasing yield tokens. `principal` is stored in **shares**; staking yield
  (~3%, variable) accrues to every account pro rata and is not part of the bet. Everything is NAV-based;
  no rebasing token is accepted.

## Pool accounting

Per (collateral, tier) pool: total YANG principal `P⁺`, total YIN principal `P⁻`.

- The **matched** amount is `m = min(P⁺, P⁻)`. Only matched principal is at risk; the excess on the heavier
  side is idle, pro rata, and earns/loses nothing until the other side grows.
- Per side an accumulator `acc_side += side · ΔS/k · (m / P_side)` is advanced on every fold the pool sees.
  An account's P&L is `principal · (acc_side_now − entryAcc)`, O(1) regardless of account count.
- Σ recorded P&L over all accounts = 0 at every step (before clamping).
- Clamping: an account that would pass its floor/ceiling is capped; the overshoot in one fold is bounded by
  the per-block limit |ΔS| ≤ 0.049, i.e. ≤ 0.049/k of principal (0.2% at the 10% tier). Overshoot is
  charged to a small pool buffer funded from fees; accounts within `ε` of the floor can be **retired** by
  anyone for a bounty, which moves their residue out and stops them diluting the matched amount.
- **Exits are always solvent**: an exiting account takes `clamp(principal + pnl)`; the pool's balance is
  Σ values by construction. Example: A (YANG) and B (YIN) 100 each → S moves → A 120, B 80 → A exits with
  120 → B's 80 remains fully backed and idle until a new YANG account C enters.

## Entry and exit timing (mandatory)

A Bitcoin block is public ~1 hour before it is folded (6 confirmations). Anyone who could enter or exit at
the last folded `S` would see the next several moves in advance. Therefore:

1. `requestEnter` / `requestExit` records `pricingHeight = relayBest + D` (D ≥ 2), a Bitcoin height **not yet
   mined** when the request lands. The relay must be fresh (its best header's timestamp within a bound),
   otherwise requests revert.
2. The request is priced at `S(pricingHeight)` once that height is folded (~3–4 hours later).
3. **No cancellation** after submit. An exiting account keeps its exposure until `pricingHeight`, so the
   amount is uncertain by roughly one-day-sd·√(4h/24h) (≈±0.2% at the 10% tier).
4. Anyone may execute a matured request; a small bounty from fees pays for it.

This applies to every design, with or without a token.

**How fresh the tip must be (found while building, 2026-09-25).** "Not yet mined" is only as good as the
relay's view of the tip. The index accepts a relay tip up to 3 h old for folding; used for pricing, that would
let a requester see the pricing block whenever keepers lag. So each pool has its own `MAX_TIP_AGE` and the
risk is bounded by P(≥ DELAY blocks mined within MAX_TIP_AGE), worst case (tip exactly at the bound):

| max tip age | D = 8  | D = 12 | D = 16 | D = 20 |
|------------:|-------:|-------:|-------:|-------:|
| 20 min      | 1.1e-3 | 1.4e-6 | 5e-10  | 6e-14  |
| 30 min      | 1.2e-2 | 7.1e-5 | 1.2e-7 | 8e-11  |
| 60 min      | 0.26   | 2.0e-2 | 5.1e-4 | 5.2e-6 |

Recommended: **30 min, D = 16** (entry/exit ≈ (16+6)·10 min ≈ 3.7 h). Residual: a relay tip whose Bitcoin
timestamp is set in the future (allowed up to 2 h) looks fresher than it is; honest headers are close to real
time, and producing a future-stamped tip costs a real block.

## Reorgs and the frozen state

- Reorgs shallower than 6 (1-block ≈ monthly, 2-block rare) never reach folded `S`: no effect.
- Deeper than 6 (only happened in 2013): the index halts as today (T9). After the 144-block delay the pool
  **freezes at the last folded S**; every account can withdraw `clamp(principal + pnl)` at that value;
  pending requests are priced at the frozen S. No new entries.

## Fees

A flat entry/exit fee in basis points, sent to `RelayerRewards` exactly like the series vaults. No
protocol owner, no fee switch, no token. Parameters (tiers, D, fee, ε, bounty) are constructor immutables.

## Out of core

- Fixed-interval bets (start/end blocks chosen in advance, 10 min granularity, ≥1h to settle) — a separate
  contract anyone can deploy against the same index.
- ERC-20 wrappers, secondary markets, lending integrations.
- Governance of any kind.

## Invariants to test

1. `balance ≥ Σ account values + pending exits` after every operation (fuzz + invariant tests).
2. Σ unclamped P&L = 0 per pool.
3. Any account can exit at any time; no sequence of other users' actions can block it.
4. No request can be priced at a height mined before the request (front-running test with mined-but-unfolded
   headers in the fixture).
5. Frozen state: every account withdraws exactly its value at the last folded S; sum ≤ balance.
6. Transfer moves the account and nothing else.
7. Yield vaults: yield accrues pro rata to shares and never enters P&L.

## Build order

1. `WujiAccounts.sol` with ETH collateral, one tier, delayed entry/exit, frozen state; invariants 1–6.
2. Tier menu + retirement bounty + fee routing.
3. wstETH/rETH vault; invariant 7.
4. Indexer/UI: show value, pending requests, matched/idle split.
5. Testnet (Sepolia) beside the existing series vault; then external audit before mainnet.

## Step 1 as built (2026-09-24) — `contracts/src/WujiAccounts.sol`

- **Pricing at an exact height without changing the index.** `WujiIndex` only stores the current S and
  series checkpoints. `mark(h, from)` recomputes `S(h)` by walking relay headers back from the index's last
  folded height (or an earlier mark), at most 1024 heights. So an executor cannot pick a favourable later S:
  every request is priced at exactly its epoch height.
- **Epochs.** Pricing heights are multiples of `EPOCH` (6 in tests ≈ 1h) at least `DELAY` above the relay's
  best height. Epochs are processed strictly in order; the pool only moves at processed epochs.
- **Rounding** always floors both sides' accumulators (1e27 precision), so dust stays in the pool.
- **Floor overshoot is measured, not hidden.** A loser that crosses 0 between epochs still credits the
  winner. `badDebt` records every such loss when the account is retired or claimed; `rawValueOf` shows the
  unrecorded ones. The fuzz test asserts `balance + badDebt + unretired ≥ Σ values`. At the 10% tier one
  epoch moves at most ≈ 6·0.049/11.5 ≈ 2.6% of principal, so overshoot needs an account to be left sitting
  at its floor; step 2 adds the retirement bounty and a fee buffer that absorbs `badDebt`.
- **Frozen state.** `freezePool` prices queued epochs at their own S while markable, then at the frozen S;
  entries priced above the last folded height are refunded in full.
- Not yet: fees, bounties, tier menu, yield collateral, ZkWujiIndex (it does not keep per-height headers,
  so `mark` needs another source there — to be solved in step 3/4).

## Step 2 as built (2026-09-24) — fees, buffer, bounties, fixed menu

- **Fee** `FEE_BPS` (≤1%) taken from the deposit on entry and from the payout on a normal exit; none on
  frozen-state withdrawals. Refunded entries (priced after a freeze) return principal; the entry fee stays.
- **Buffer.** Fees stay in the pool first. Floor overshoot is charged to the buffer before it can become
  `badDebt`. Bounties (`BOUNTY`, paid per processed epoch and per retirement) come only from the buffer, so a
  keeper can never be paid out of anyone's principal. Buffer above `BUFFER_BPS` of live principal is
  `sweep`-able to the treasury (the FeeRouter → RelayerRewards).
- **Menu.** `WujiAccountsFactory` holds the three tiers as constants (K = 23 / 11.5 / 4.6 → 5% / 10% / 25%)
  and creates them once per collateral, by anyone. No new tier can ever be added to an existing factory.

## Step 3 (2026-09-25) — yield collateral needs no new code

Principal and P&L are counted in token units. A non-rebasing yield token (wstETH, rETH) never changes
balances; its ETH value per token rises. So yield reaches every holder through the token itself and never
touches the bet. `test_yieldTokenNavAccruesOutsideTheBet` checks it with a mock whose NAV rises 3%: P&L is
unchanged and token payouts sum to deposits. Deploying the yield pools is one `factory.create(wstETH, …)`.
Rebasing tokens (stETH) must not be used: their balance changes would be mistaken for pool money.

## Step 4 (2026-09-25) — indexer, keeper, terminal

- `indexer/accounts.mjs`: dependency-free pool and account readers, plus `maintainPool` keeper duties
  (process ready epochs, retire floored accounts in a bounded rolling scan, sweep buffer surplus,
  `freezePool` after the index freezes). Unit-tested, and `accounts.integration.test.mjs` reads a real
  compiled pool on a throwaway anvil chain (unlocked account, no key) so ABI offsets are checked against
  the contract, not against a fixture.
- `bitcoin-index.mjs`: `ACCOUNTS=<pool,...>` adds `head.chain.accountPools` and `GET /account/<pool>/<id>`.
- `bitcoin-keeper.mjs`: the same `ACCOUNTS` list is maintained every round, also after an index freeze.
- Terminal: a read-only 永续账户 tab (tiers, yang/yin split, matched vs idle, queued pricing heights, buffer,
  bad debt, account lookup). Pool and account payloads are validated and escaped like vault data, and the
  tab clears itself when the snapshot is stale.
- Wallet actions (enter with approve, irrevocable exit with a confirm dialog, claim) work **only for pools
  listed in the page's built-in `RELEASES[...].accountPools`** — an indexer can suggest a pool, never
  authorize one. Before every transaction the page re-reads the pool's `asset()` and `K()` through the
  wallet's own RPC and stops if they differ from the release entry. The account id is taken from the
  `EnterRequested` log and remembered in this browser only. No pool is released yet, so today every pool
  shows read-only.

## Step 4b (2026-09-25) — pricing without relay history, and the tip-age hole

- `markWithHeaders(height, to, headers)`: anyone supplies the raw headers `height+1..to`; the pool checks they
  link by hash to the index's `lastHash` (or to an earlier mark) and subtracts their increments. No relay
  history, no PoW check needed (linkage to an already-accepted tip is enough), so it works with an index that
  keeps only its tip. `hashAt` stores the anchor so marks can chain downwards. The increment is computed
  locally (same byteSum as the index).
- `MAX_TIP_AGE` (see the table above) replaces the index's 3 h freshness for requests. This was a real hole in
  step 1, now covered by `test_poolFreshnessIsTighterThanTheIndex`.

### Still open for ZkWujiIndex: where does "best height" come from?

Marking is solved; request scheduling is not. `ZkWujiIndex` stores only its folded tip: `foldHeaders` validates
6 headers beyond it and discards them, and the proof journal does not output them. Options:

1. **Record the seen tip in ZkWujiIndex** (`seenHeight`, `seenTime` = the last validated header in
   `foldHeaders`; `newHeight + 6` and a new journal field for `foldProof`). Cleanest; changes the guest's
   journal, so a new vkey — acceptable while nothing is on mainnet. *Recommended.*
2. **Price from the folded tip**: `pricing = lastHeight + 6 + D`, with MAX_TIP_AGE applied to the folded tip's
   time. Folded tips are ≥ 1 h old by construction, so D must be ≈ 24 (60–90 min row), i.e. ≈ 5 h per entry
   or exit. No index change.
3. Keep a thin header relay only for the best tip. Brings back the per-header gas ZK was built to remove.

## Step 5 (2026-09-25) — live on BSC testnet

Deployed against the running BSC testnet stack (index `0xe26b…d19b`, timestamps-v3, P2P source, keeper live)
rather than Sepolia: the Sepolia deployer had 0.00018 ETH and the Sepolia relay was three days stale.
Collateral: the testnet mock WBNB. Addresses and parameters are in
`contracts/deployments/bsc-testnet-timestamps-v3.json` → `accounts`, and registered in the terminal's
`RELEASES.bsc.accountPools`; `scripts/bitcoin-testnet.sh` passes them to indexer and keeper as `ACCOUNTS`.

**First attempt was unusable, and why.** v1 pools called `index.frozen()` and `index.historyConsistent()`,
which exist only on indexes with the T9 frozen exit. On this v3 index every request reverted. The deploy
simulation did not catch it because it only deployed. Fixes: the pool probes `frozen()` once
(`INDEX_CAN_FREEZE`), checks history consistency itself from `lastHash`/`relay.headerAt`, exposes
`acceptingRequests()`, and the deploy script now requires it for every pool before finishing. The v1
addresses are recorded under `accounts.abandoned`; they never accepted a deposit.

Smoke test: yang 1 WBNB and yin 1 WBNB into the 10% pool, priced at Bitcoin height 968556 (requested at relay
best 968539).
