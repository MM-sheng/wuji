# WUJI threat model

Status: Bitcoin-source testnet prototype, updated after the 2026-09-20 adversarial review. The source
contains T2 storage packing, T1 operations-reserve bounties, T2b header-time checks / bounded tip-age gating,
and the **not-yet-deployed T9 frozen-exit candidate** described below.
Ports 8790 and 8791 retain their earlier immutable comparison deployments. T2b evidence is in
[tasks/T2B_REPORT.md](tasks/T2B_REPORT.md). Ports 8792/8793 still use v3 without T9 exits. Independent review,
the T9 parameter decision and a new testnet integration/exit drill remain pending.
Legacy BSC Gap/EIP-2935 rules do not apply to Bitcoin mode.

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
- **Header validation:** PoW, links, branch-local retargets, cumulative-work selection, MTP11, the two-hour
  future limit and mainnet buried minimum-version rules are enforced. The future bound uses the host EVM
  clock, not Core's local NodeClock. Timestamp acceptance is therefore not clock-source equivalence.
  Transactions, scripts, merkle/body consistency, transaction-triggered softfork rules and full block validity
  are not checked. These omissions cannot bypass the checked hash target or manufacture cumulative work
  without the corresponding PoW; they can still admit a costly higher-work header chain invalid to full nodes.
  Header acceptance must not be described as complete Bitcoin consensus verification.
- **Settlement chain:** execution and finality depend on the chain hosting each vault. Identical Bitcoin input
  does not make tokens on different chains interchangeable or guarantee synchronized availability.
- **Collateral:** issuer freezes, blacklisting, proxy upgrades, rebasing, dishonest balances and transfer fees can
  break availability or accounting assumptions. Collateral units do not insure dollar purchasing power or BNB
  exposure. The factory is permissionless and offers no equal-safety promise for arbitrary-token vaults.
- **Succinct proof verification (T10, not yet deployed):** `ZkWujiIndex.foldProof` accepts a batch on the
  word of a zkVM verifier contract and an immutable verifying key. That verifier and the proof system
  behind it join the trusted base, which today is only the EVM plus the header rules written in Solidity.
  This is a real increase and is not offset by any argument about succinctness. Its shape:
  a broken *prover* cannot stop the protocol — `foldHeaders` validates raw 80-byte headers in Solidity with
  the identical rules and is always callable — but a broken *verifier* could admit a false index increment,
  and nothing downstream would detect it. Mitigations are partial: the verifier is immutable and audited by
  its own project, the verifying key is fixed at deployment, the guest and the Solidity path are
  differential-tested over real mainnet headers, and the journal's configuration and future-time bound are
  checked by the contract rather than chosen by the prover. A deployment that wants no new trust at all
  should simply not set a verifier and use the header path only — `foldProof` then reverts, and the
  constructor rejects any verifier address that holds no code, because `verifyProof` returns nothing and
  Solidity emits no extcodesize check for such a call: a misconfigured verifier would otherwise accept
  every proof silently.
  **T12 (source, not deployed) narrows this:** a proof only opens a pending batch; it becomes final after a
  challenge window unless disputed with a bond, and a disputed batch survives only if its raw headers,
  replayed by the Solidity rules, reproduce it exactly. A broken verifier then moves the index only if no
  honest watcher disputes within the window, and `refute` (WUJI-08) answers each forgery at once with real
  headers, folding the real state, so forgeries cannot hold the index either. Residual risks: watcher
  absence for `W` (loss), griefing that delays honest batches by `W + R` per lost bond, a reject reward a
  griefer can collect if nobody backs an honest batch within `R`, and forgeries that cost the attacker only
  gas (WUJI-09).
- **Keeper/data sources:** anyone can submit, fold and settle. Losing keepers or APIs delays progress; no Bitcoin
  height is skipped or replaced by zero. Public APIs can stall or mislead the cache; use independent sources or
  local Core/Esplora. HTTP success is not proof of Bitcoin consensus. `BITCOIN_SOURCE=p2p` removes the HTTP
  dependency entirely: the keeper speaks the Bitcoin wire protocol, validates every header from the genesis
  block with the relay's own rules, and trusts no API operator. A peer can still stall or withhold; it cannot
  fabricate a chain without the corresponding proof of work.
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

T11 perpetual accounts do close this window for their own entries and exits: every request is priced at a
Bitcoin height that was not yet mined when it landed (see §T11 below). Series tokens and any secondary
market remain exposed as described here.

## Fixed-height settlement and deep reorgs

Series boundaries are `GENESIS_HEIGHT + k·4320 − 1`. Each is approximately 30 days apart on average, not
a calendar deadline. Settlement reads only the recorded boundary S, so a later caller cannot select a later S.
This removes the settlement-call timing option, not miner influence or the information window.

Six descendants are a probabilistic margin. If a heavier branch replaces a folded height, `fold` reverts
with `deep Bitcoin reorg`, including when called without pending work. No zero increment is substituted and
previous payments cannot be undone. Full pairs can still be redeemed, but an unsettled one-sided holder
has no guaranteed protocol exit on the existing v3 deployments. A market buyer is not an assured recovery
mechanism. The T9 source candidate below supplies a conditional exit on new deployments, without undoing
historical payments. Different deployments can halt at different heights. Deep fork rewrites can also exceed
transaction gas limits.

### T9 source candidate: branch-bound observation and terminal settlement

A separate successful `observeReorg()` call records the mismatch; a reverting fold cannot persist it.
The record binds last folded height/hash, observed relay height/tip and `BitcoinRelay.reorgCount`.
The immutable test-candidate delay is 144 beyond the greater of observed relay height and folded height.
The record must remain valid: unchanged folded state, a continuing mismatch, identical relay revision and
the same canonical hash at the observed height. Any subsequent winning non-extension invalidates the record,
including a restoration and re-divergence that no index caller witnessed. Repeating a valid observation cannot
extend its deadline. Shorter higher-work chains cannot shorten the base below the last folded height.

On reaching the height threshold, anyone can `freeze()` the index permanently. Each vault separately calls
`settleFrozen()` and closes without creating a successor. An already recorded **own** maturity checkpoint fixes
the original payoff; with no own maturity checkpoint, the share is 1/2. Earlier/later checkpoints are ineligible,
including checkpoints preceding a late-created vault. Previously settled series and payments never change.
Current-series mint and ordinary settlement are rejected as soon as history mismatches; matched pairs and
already settled claims remain redeemable with the existing fee and rounding. Closed vaults never reopen even
if the original Bitcoin branch later returns, since withdrawals may already have relied on the exit allocation.

This preserves solvency under the same standard-token assumptions, but **does not preserve every holder's
economic value**. With whole-claim holdings qY/qN and a stipulated counterfactual normal payoff a, changing to
half yields approximately `N*(qY-qN)*(0.5-a)*(1-0.0005)` incremental collateral after fees. The gross absolute
difference is at most `N*abs(qY-qN)/2` for a in [0,1]; external positions and leverage can increase total incentive.
For example, ten YANG, notional 100 and counterfactual a=0.1 gain 400 gross / 399.8 net relative to that payoff,
at the other side's expense. This is a scenario, not a prediction from the current displayed share or a live quote.
For a boundary already recorded, the candidate does not let the caller choose a new allocation.

144 heights are an observation window, **not** a proven unprofitable-attack threshold or safe TVL limit.
Subsequent headers may be honestly mined or already available; the attacker does not necessarily pay to mine
144 fresh blocks after the notice. Private fork/withholding costs, external exposure, partial SPV views and
host-chain censorship matter. There is no on-chain exposure cap. Independent economic/security review of the
half-allocation policy, delay and release exposure is required before mainnet.

Residual liveness costs are explicit: even a shallow winning fork on the replacement branch resets the notice;
an attacker may postpone exit by provoking repeated changes. A missing relayer cannot advance the threshold.
Ordinary staleness or elapsed wall time alone does not trigger exit. No new bounty pays observe/freeze/closure
calls. Standalone relay submission remains available after a seal; submit-and-fold reverts atomically.
Allocated historical rewards remain claimable, but unallocated reserve and fees arriving after the index is
sealed have no future fold task to pay and may remain locked permanently. There is no rescue owner or migration key.

Specification, implementation boundaries and tests: [T9_DESIGN.md](tasks/T9_DESIGN.md),
[T9_REPORT.md](tasks/T9_REPORT.md). No existing immutable deployment is upgraded by this source change.

## Defences and evidence

- No owner, upgrade, pause, governance or arbitrary withdrawal path.
- Reentrancy guards, SafeERC20, received-balance checks on mint, collateral-favouring integer rounding.
- Deterministic checkpoint payoffs and full-pair redemption; no guarantee of single-sided early redemption.
- Original vault invariant assertions retained with 64 runs × 60 calls and fail_on_revert enabled. Economic
  tests use explicitly synthetic feeders; they do not test mining security. Production PoW uses 6060 real
  headers with four retargets and 345 Core-derived timestamp vectors; synthetic branch tests have a test-only
  easy-target subclass. The original fixture and financial invariant assertions are unchanged.
- T2b measured steady/new-worker batch gas is about 86.6k/91.6k per header; smaller batches, initialization, retargets and fork rewrites can
  cost more. Include folding, rewards, transaction/calldata and settlement costs in liveness economics.
- Independent review of the exact release source, parameters and deployed bytecode is still required.

## Fees and operational liveness

Current source routes 100% of fees into an immutable operations reserve. Only the immutable index can
allocate bounties for the next contiguous range of folded heights. Per selected token and per height it
reserves floor(available reserve / 10000). Allocated but unpaid claims are excluded from available reserves.
There are no lifetime points, historical fee shares or burns. Funding and syncing a direct donation can
only benefit future fold calls; delayed withdrawals receive their previously fixed amount.

The caller must select up to eight sorted unique tokens and at most 256 rewarded heights. This is bounded
operator choice, not protocol token curation. Unselected tokens, empty pools and no-reward fold calls create
no later rights. The sequential floor calculation makes batch splitting neutral. Below 10000 base units,
the bounty is zero even with nonzero funds. Unit/fuzz/stateful tests check conservation and no future-fee claims.

Allocation touches no ERC-20 code. Fund/sync/claim use reentrancy guards and accounting checks; an unsupported
token's failure affects its own funding/withdrawal, not other assets or index folding. Negative rebases,
issuer controls and dishonest balances remain unsupported. Claim checks are not a general token audit.

The optional atomic submitAndFold call credits its external caller. It removes the gap between the caller's
header submission and fold, but another party can copy/front-run the whole transaction and pay for the work.
A standalone header submitter can still lose the folding bounty to someone else. Anyone may deliberately
fold without rewards, which advances the index and consumes those opportunities without paying them. This
costs the caller gas and does not remove reserve funds, but cannot be excluded as economic griefing.

The keeper uses an explicitly configured token list, normally takes the atomic path, and by default attempts
fee collection and claims only every 144 folded heights. This limits gas spent on tiny transfers. Separate
submit/fold remain available for fork recovery; an atomic call that fails folding also reverts its submissions.
Independent relaying can continue after a deep reorg. New deployments can use the T9 candidate's conditional
exit; existing v3 deployments cannot. The residual reserve limitation above is deliberately not a new withdrawal permission.

The economic model in ARCHITECTURE §4 includes single-height and batch measurements. Nonzero reserves do not
promise profitable operation: without income they decay, and fees, token prices, routing, competition and
server costs matter. The old lifetime-points/DEAD deployments are immutable historical comparisons, not the
new mechanism. CREATE address binding and deployed bytecode must be checked for each new deployment. The
future native-ETH/CREATE2/ZK target is separate work, not a property delivered by this ERC-20 reserve.

## T11 perpetual accounts

`WujiAccounts` pools ([design](tasks/T11_PERPETUAL_ACCOUNTS.md)) add a second product on the same index:
fixed principal, additive P&L `principal·ΔS/K` clamped to [0, 2·principal], no expiry, no owner.

**Pricing and the public-information window.** A request is priced at the first epoch height ≥ relay best +
DELAY. That only protects anyone if the relay's best is close to the real tip. The index accepts a relay tip
up to 3 h old for folding; used for pricing, that would let a requester see the pricing block whenever keepers
lag. Each pool therefore requires the relay's best header to be at most `MAX_TIP_AGE` old. The chance that the
pricing block already exists is at most P(≥ DELAY blocks mined within MAX_TIP_AGE): about 1e-7 at the
deployed 30 min / 16 blocks, worst case. Residual: a best header stamped in the future (Bitcoin allows up to
2 h) looks fresher than it is. Honest headers are close to real time, and making a future-stamped tip costs a
real block. This hole existed in the first implementation and was found while building, not by review.

**Floor overshoot.** A loser can cross 0 between two priced epochs; the winner is still credited the full
move. The shortfall is charged to the pool's fee buffer first and only then recorded as `badDebt`, which is
public. After every payout the buffer is clamped to the pool's real balance, so a winner paid out of a
floored loser's overshoot can never leave bounties or `sweep` counting tokens that are gone (a self-review
finding that bricked the pool in a stateful test). Keeping it at zero depends on anyone retiring accounts at their floor (paid a bounty from the buffer)
and on epoch moves being small (≤ ≈2.6% of principal per 6-height epoch at the 10% tier). A pool with a large
`badDebt` pays exits in order until its balance runs out: late exits bear the shortfall. At high tiers or
with absent keepers this is a real, not theoretical, loss path.

**Buffer accounting.** On BSC testnet the keeper's routine `sweep()` sent every entry fee to the treasury
before the entries were priced, because the buffer target counted only live principal. Fixed by counting
`pendingPrincipal`; v2 pools with the bug remain on chain, unmaintained.

**Index compatibility.** The first BSC deployment called `frozen()` / `historyConsistent()`, which the v3
index lacks; every request reverted. Pools now probe once and check consistency themselves, and the deploy
script requires `acceptingRequests()` before finishing. Deploy-time simulation of a real request is now
part of the release procedure.

**Keeper bounties.** Processing an epoch or retiring a floored account pays 1/10000 of the pool's buffer.
A share cannot exceed the buffer or be farmed faster than one share per epoch; in a small pool it may not
cover gas at all. A self-review found the earlier fixed bounty could be farmed with 1-wei-fee entries.

**Liveness.** Nothing expires, so an absent keeper delays but does not destroy anything: pending requests
wait, and anyone (including the account owner) can call `processMany`, `retire` and `claim`. Pricing an epoch
recomputes S by walking relay headers back from the index tip, at most 1024 heights per call; after a longer
outage `process` bridges down one 1024-height chunk per call by itself (≈1.5M gas each), so recovery needs
only repeated calls, not manual marks.

**Deep reorgs.** On an index with the T9 frozen exit, the pool freezes with the index: queued epochs are
priced at their own S where it can still be recomputed, else at the frozen S; entries priced after the last
folded height are refunded; open accounts withdraw at the frozen S. **On an index without T9 (BSC testnet
v3) there is no frozen state:** after a deep reorg the pool stops accepting requests and stops pricing
epochs, so queued exits cannot complete until the relay's history again matches the folded tip. Mainnet
pools must be bound to an index with the frozen exit.

**Front-end trust.** The terminal only enables wallet actions for pools in its built-in `RELEASES` list and
re-reads each pool's `asset()` and `K()` through the wallet's own RPC before every transaction. An indexer
can make the page display a pool; it cannot make the page approve or deposit into one.

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

## T2b bootstrap and freshness boundary

The constructor receives the eleven raw headers immediately before the trusted checkpoint. Their complete
hash linkage must terminate at the checkpoint's committed parent hash; this authenticates the timestamps
under the existing checkpoint trust and hash assumptions. The constructor checks the checkpoint's own MTP
and future bound. It does not independently revalidate ancestor PoW, bodies or the chain before that window.
The pre-existing checkpoint/height/epoch-start/work trust is not removed. Forks below the checkpoint are unsupported.

Every new header must have time strictly greater than its own parent's MTP, not the current canonical tip's
median. The sorting window is always eleven timestamps; initialization fills missing predecessors from the
authenticated history. Equal-to-median fails; exactly host clock + 7200 seconds succeeds. Mainnet version
floors are 2 at height 227931, 3 at 363725 and 4 at 388381, compared as signed int32 values.
The fixed source and the limits of the Core-derived differential harness are documented in the T2b report.

With pending heights, all fold entrances (including fold(0)) require the best tip's advertised time to be
within [host clock - 10800, host clock + 7200]. An empty backlog permits no-op folds and bootstrap vault creation.
The deep-reorg check runs first even on an empty backlog. A stale rejection changes no index, checkpoints or
reward allocations. Atomic submit/fold rolls back all headers too; standalone submit remains usable to catch up.
The keeper simulates with its actual caller address and falls back to standalone submission on this rejection.

This is an age bound, not a proof of synchronization to the global highest-work chain. An adversary may relay
an incomplete but sufficiently recent branch. Since a header may be up to two hours in the future, its time
can remain inside the three-hour age bound for about five hours after publication, with host/node clock
variation adding further uncertainty. A natural three-hour Bitcoin block gap can also stop folding; a valid
new tip restores it without a key. This gate does not remove public-information delay, force a miner to publish,
or repair a persistent mismatch of folded history. The T9 candidate terminates affected contracts instead of
repairing the history; its review and public-testnet validation remain separate required work.
