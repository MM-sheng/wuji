# WUJI threat model

Status: Bitcoin-source testnet prototype, updated after the 2026-09-20 adversarial review. The source
contains T2 storage packing; port 8790 still runs the earlier T1 comparison deployment. Operations-reserve
bounties (T1 rework), complete header timestamp checks/catch-up gate (T2b), and frozen-state exit (T9)
are pending. None is an implemented protection. Legacy BSC Gap/EIP-2935 rules do not apply to Bitcoin mode.

## Objective and assumptions

Under ordinary ERC-20 behaviour, the vault balance covers all open and settled series liabilities,
and one YANG/YIN pair has a gross collateral payoff of exactly NOTIONAL. Fees and integer rounding
are separate. This is a conditional solvency property, not a price or return guarantee. It assumes
honest balance reporting, correct transfers and no external reduction/rebasing of the vault balance.
Minting checks the received balance delta; that does not make a malicious or upgradeable token safe.
No privileged account can change parameters, withdraw backing, pause users or upgrade the contracts.

`S`, instantaneous share `clamp(½+½ΔS)`, expiry payoff and executable market price are different objects.
The share is an absolute-position allocation, not a lending-collateral price feed. Off-chain floating
point values only display results; contract integers determine claims. A family of claims may share the
index while differing by chain, collateral, notional, series, liquidity or frozen state. A symbol alone
is not an asset identifier; publish chain ID, collateral address, notional, series, side and token/vault addresses.

## Trust boundaries

- **Bitcoin checkpoint and SPV:** deployment trusts a header, height, epoch-start timestamp and work baseline.
  Compare them with independent Bitcoin sources. An incorrect epoch timestamp can distort the first retarget.
  Testnet chainwork is normalized to the checkpoint's own work; the omitted common prefix cancels in fork comparisons.
- **Header validation:** PoW, links, branch-local retargets and cumulative-work selection are enforced.
  Transactions and full block validity are not checked. MTP, future-time limits and a caught-up relay gate are
  still missing; six local descendants can exist on a stale view. Target-derived work cannot simply be invented,
  but that is not proof of Bitcoin Core equivalence. T2b must address the timestamp/catch-up omissions.
- **Settlement chain:** execution and finality depend on the chain hosting each vault. Identical Bitcoin input
  does not make tokens on different chains interchangeable or guarantee synchronized availability.
- **Collateral:** issuer freezes, blacklisting, proxy upgrades, rebasing, dishonest balances and transfer fees can
  break availability or accounting assumptions. Collateral units do not insure dollar purchasing power or BNB
  exposure. The factory is permissionless and offers no equal-safety promise for arbitrary-token vaults.
- **Keeper/data sources:** anyone can submit, fold and settle. Losing keepers or APIs delays progress; no Bitcoin
  height is skipped or replaced by zero. Public APIs can stall or mislead the cache; use independent sources or
  local Core/Esplora. HTTP success is not proof of Bitcoin consensus.
- **Indexer/UI and markets:** caches can lie without changing contract state. Match `S_wad` at the same height
  and verify its header proof. Displayed settlement shares and simulated order books are not executable quotes;
  before expiry even an idealized price depends on the remaining payoff distribution.

## Miner influence and private attack cost

A miner can compute the increment after finding a valid header, then withhold/discard it. Rehashing removes
raw PoW zero-bit bias; it does not prevent selective publication or establish perfect independence. Model
the attacker's private marginal cost, not a universal full-network block reward: pool arrangements, shifted
costs, fees, hash share, external positions and short-lived concealment can change the economics.

A simplified one-block selection model in the review gives a profitability condition
`A · s > sqrt(2π) · c_b`, where A is the model's effective one-sided exposure, s is per-block S standard
deviation and c_b is the attacker's private cost per discarded block. At s = 0.005, its threshold is
about `501 · c_b`; assuming c_b = $200,000 gives about $100 million. These are **hypothetical model inputs**,
not observed mining costs or a proven safe TVL limit. Gross vault collateral need not equal A, especially
near payoff boundaries or with external leverage. Smaller exposure does not exclude other attacks.

Early deployment exposure should be conservatively constrained and the cost assumptions published, but
there is currently no contract-enforced exposure cap. Do not advertise the toy threshold as guaranteed safety.

## Public information window

Once a Bitcoin header is public, its WUJI increment is known even before it is relayed, reaches six-deep
status, or is folded on a settlement chain. A market participant can act on that information while another
participant relies on stale UI/contract state. Six confirmations address reorg risk, not information equality.
The protocol currently does not prevent trading on this public-information delay. Market makers still face
adverse selection, inventory risk and collateral risk; a deterministic index does not remove them.

## Fixed-height settlement and deep reorgs

Series boundaries are `GENESIS_HEIGHT + k·4320 − 1`. Each is approximately 30 days apart on average, not
a calendar deadline. Settlement reads only the recorded boundary S, so a later caller cannot select a later S.
This removes the settlement-call timing option, not miner influence or the information window.

Six descendants are a probabilistic margin. If a heavier branch replaces a folded height, `fold` reverts
with `deep Bitcoin reorg`, including when called without pending work. No zero increment is substituted and
previous payments cannot be undone. Full pairs can still be redeemed, but an unsettled one-sided holder
has no guaranteed protocol exit. A market buyer is not an assured recovery mechanism. T9 must define and
analyse an immutable frozen-state exit before mainnet; it does not exist today. Different deployments can
halt at different heights. Deep fork rewrites can also exceed transaction gas limits.

## Defences and evidence

- No owner, upgrade, pause, governance or arbitrary withdrawal path.
- Reentrancy guards, SafeERC20, received-balance checks on mint, collateral-favouring integer rounding.
- Deterministic checkpoint payoffs and full-pair redemption; no guarantee of single-sided early redemption.
- Original vault invariant assertions retained with 64 runs × 60 calls and fail_on_revert enabled. Economic
  tests use explicitly synthetic feeders; they do not test mining security. Production PoW uses 2028 real
  headers spanning one retarget; synthetic branch tests have a test-only easy-target subclass.
- T2 measured batch gas is about 68k/header; smaller batches, initialization, retargets and fork rewrites can
  cost more. Include folding, rewards, transaction/calldata and settlement costs in liveness economics.
- Independent review of the exact release source, parameters and deployed bytecode is still required.

## Fees and operational liveness

The current comparison deployment uses the superseded 50% lifetime-point / 50% DEAD design. Sending ERC-20
collateral to DEAD does not necessarily reduce totalSupply. Credits accrue to the original submitter and
folder only on finalized heights; duplicate/transient orphan headers cannot mint extra credits. Already-paid
rewards cannot be reversed after a deep reorg. Points persist and dilute new workers' share of future fees.

Its token-specific accumulators and bounded claim lots isolate accounting; credit calls no token code.
Distribution occurs at sync, with precision dust reserved. Unsupported token behaviour may block its own
routing/claims. CREATE nonce prediction binds immutable addresses and must be checked during deployment.
These are facts about the existing version, not an endorsement of lifetime-point economics.

The approved task queue replaces this with 100% fees in an immutable operations reserve and one-off,
per-finalized-height bounties to the folder. Permissionless funding is a donation, not control. The redesign,
per-token accounting, gas/fee-volume model and deployment remain pending. Empty reserves, low primary-market
volume and front-running can still make work uneconomic; no implementation can promise profitable operation
without explicit resource assumptions. T8 requires independent keepers and a 48-hour author-shutdown drill.

## Monitoring

Watch relay lag, stale best-header time, index backlog, keeper errors, overdue checkpoint settlement,
reorg reverts, collateral balance below liabilities, collateral implementation changes, and same-height
index/contract mismatches. Float displays with tolerance are not exact solvency evidence: use raw token
units for monitors. `liabilities()` iterates all series and is intended for off-chain monitoring.

## T2 compact representation


Work remains bounded to uint128 and height to uint32, checked in wider arithmetic before narrowing.
Node, epoch and worker IDs are checked before exhaustion; no wraparound or record alias is permitted.
Parent hash compression relies ONLY on the existing Bitcoin-mainnet PoW_LIMIT of 2^224-1, with an explicit
range check and lossless round-trip tests. It is not appropriate for a chain with a looser PoW limit.

Two node metadata records share a word. IDs are never reused, so insertion only fills a previously empty half.
Branch-local epoch records are immutable. Within an epoch, baseWork + offset * blockWork is exact; a retarget
creates a separate record with the new baseWork/bits/firstTime. Arbitrary checkpoint heights preserve the real
epoch-start timestamp independently of the work baseline. Differential fixtures and shorter/heavier forks test this.

Work reconstruction and worker lookup remain constant-time; no unbounded scan was moved into reward claims.
Header submission makes no untrusted callbacks, so committing the cached best tip at batch end is atomic.
Synthetic easy-target tests alone store full parents separately because their hashes violate the mainnet bound.
The production deployment has no such alternate storage path. Gas targets apply to measured batches, not arbitrary
fork rewrites, first-worker setup, or single-header transactions. Independent review must include the compact encoding.
