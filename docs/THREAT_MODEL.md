# WUJI threat model

Status: testnet prototype. This document describes the current contracts, not a claim that they
are ready to custody production funds.

## Security objective

For every series, one fully backed pair represents exactly one `NOTIONAL` of collateral. At all
times the vault balance must cover the sum of all open and settled claims. No privileged account
may change the index, mint claims, withdraw collateral, pause users, or upgrade the contracts.

## Trust boundaries

- **BNB Chain consensus and block production:** block hashes are the sole index input. Validators
  cannot choose arbitrary hashes, but block hashes are not an unbiased randomness beacon and a
  proposer may have limited withholding/reordering influence.
- **EIP-2935 history contract:** hashes older than 256 blocks depend on the canonical history
  contract at `0x0000F90827F1C53a10cb7A02335B175320002935`.
- **Collateral:** solvency is denominated in units of the configured ERC-20. Depeg, issuer freeze,
  blacklist, proxy upgrade, or chain bridge failure remain collateral risks.
- **Keeper:** the keeper has no authority; it only calls public functions. Its key can waste its
  own gas. Loss of all keepers can cause deterministic zero-increment gaps.
- **Indexer and UI:** caches only. They may lie or fail without changing contract state. Users must
  be able to compare their result with public RPC data.
- **DEX pools:** secondary prices depend on liquidity and can diverge from claim value. Pair
  mint/redeem constrains the sum of YANG and YIN, but does not guarantee either side trades at its
  displayed claim value before settlement.

## Mainnet blockers

### Settlement-time optionality — unresolved

The current series expires by timestamp, while `settle()` freezes the index at the block immediately
before the settlement transaction. A caller may wait after expiry and choose a later path point that
favours the side they hold. A fast keeper reduces the window but does not remove the option, and is
therefore not a security proof.

Mainnet requires a rule that fixes the settlement block before its hash is known and makes the exact
index value at that block recoverable on chain. Candidate design: block-number series plus index
checkpoints at deterministic boundaries. This changes the protocol and needs its own tests and review.

### Independent review — unresolved

The contracts have internal unit, fuzz, and invariant coverage, but no independent audit or formal
verification. At least one reviewer who did not author the contracts must review source, deployment
parameters, compiler settings, and the final deployed bytecode.

## Defences implemented

- No owner, proxy, pause, governance, or arbitrary withdrawal path.
- `ReentrancyGuard` and `SafeERC20` protect vault entry points and token calls.
- Minting measures the vault balance delta and rejects fee-on-transfer collateral.
- Settlement refuses to proceed when the index backlog exceeds one bounded tick, then verifies the
  index is fully caught up. Old blocks cannot silently spill into the next series.
- Missing hashes outside the 8191-block history window contribute exactly zero and emit `Gap`.
- Mint fees round up; payouts and redemption fees round down in the vault's favour.
- Deployment requires an explicit chain id, treasury, and production collateral. Mock collateral is
  available only behind an explicit test flag.

## Failure modes that remain by design

- A gap changes the realized path by freezing missing increments at zero.
- At `yangShare` 0 or 1, one side has no settled claim; the payoff is bounded rather than an
  unbounded replica of `100 * exp(S)`.
- `liabilities()` grows linearly with the number of series and is intended as a view/monitoring call.
- Treasury is immutable and receives protocol fees. Compromise cannot drain vault collateral, but
  the recipient and its control policy must be disclosed.
- Tokens that rebase, blacklist the vault, return dishonest balances, or otherwise violate ordinary
  ERC-20 semantics are unsupported even if deployment succeeds.

## Monitoring signals

Alert on `Gap`, keeper transaction failures, `pending() > 256`, expiry without settlement, vault
balance below `liabilities()`, unexpected collateral implementation changes, and any mismatch between
the indexer's `S_wad` and `WujiIndex.S()`.
