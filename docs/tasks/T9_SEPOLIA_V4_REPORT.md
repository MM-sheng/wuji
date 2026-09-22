# T9 Sepolia v4 deployment

Later runtime follow-up: [T8_KEEPER_RUNTIME.md](T8_KEEPER_RUNTIME.md) records the direct-read fix and current
process/funding status. The receipt and balance observations below describe the initial rollout.
The latest recovery and two-source replay are in [T8_RECOVERY_REPORT.md](T8_RECOVERY_REPORT.md).

## Status

The frozen-exit candidate is deployed on Ethereum Sepolia. All seven deployment receipts succeeded in
EVM block **11752027**. Fresh compiler output matches all seven deployed runtimes, including metadata with
only compiler-declared immutable slots masked; separate deployment-binding and Bitcoin-anchor checks passed.
The terminal now registers the actual v4 addresses alongside the existing v3 releases.

Live catch-up and exact-height reconciliation passed at Bitcoin height **968013**. The public WETH smoke
completed with seven successful transactions and exact final balance assertions. This report does
not claim an independent audit, an economically approved exit delay, a real deep Bitcoin reorg, or the T8
48-hour independent-operator disappearance drill. Mainnet remains gated.

## Identity and evidence

- Source commit: `1b099529715874da35a1958bbde8afb5aabb6973`.
- Chain ID: `11155111`; genesis **967826**, relay checkpoint **967825**, interval **4320**, confirmations **6**.
- Exit delay: **144 Bitcoin relay heights**, a test candidate. Fee remains **5 bps**.
- Collateral: existing Sepolia WETH `0xfff9976782d46cc05630d1f6ebab18b2324d6b14`; **0.001 WETH** per pair.
- Index: `0x67a6ec0afa4f9b4dfe1d7d111a92302bd9e15e6e`.
- Relay: `0xd10d08faf8cf4ca582319fe56df223203a852d02`.
- WETH vault: `0xC350b5b77E0Cc7853cCD3C1EDEC562DE09e98195`.
- [Deployment manifest](../../contracts/deployments/sepolia-weth-v4.json): all addresses and transaction hashes.
- [Fresh bytecode comparison](../../contracts/deployments/sepolia-v4-bytecode.json).
- [Initial binding/anchor checks](../../contracts/deployments/sepolia-v4-verification.json).
- [Bootstrap transaction journal](../../contracts/deployments/sepolia-v4-bootstrap.json).
- [Live fixed-block reconciliation](../../contracts/deployments/sepolia-v4-live.json).
- [Reconciliation after automatic catch-up](../../contracts/deployments/sepolia-v4-live-after-resume.json).
- [Public WETH mint/redeem smoke](../../contracts/deployments/sepolia-v4-smoke.json).
- [Funding and runtime operation evidence](../../contracts/deployments/sepolia-v4-operations.json).

These are newly deployed immutable contracts; none of the old v3 addresses has acquired the new exit rule.
The initial binding check intentionally records an empty index and stale anchor while catch-up is pending.

The keeper first relayed heights 967826–967849. Bounded bootstrap transactions then relayed through 968019
and folded 188 six-deep heights in one permitted `fold(256, rewardTokens)` call. The deployed index returned
`S_wad = -69744000000000000` at height 968013, equal to the indexer and the terminal's own verification function.
The relay was fresh, history consistent, exit phase active, and the WETH vault open. These are observations
at the recorded EVM block; a new Bitcoin tip may arrive while later smoke transactions run.

After smoke, the regular v4 keeper automatically submitted and folded new heights 968020–968021 in
`0xa24e304deb83821ce4ff39b51db85afe4f2b8aba92cc09f32df55435ffe1f5a8` (Sepolia block **11752225**).
The transaction used **403,744 gas** with a **511,923** gas limit, rather than reserving the operation's
8,000,000 ceiling. The follow-up terminal verifier matched **968015**, `S_wad = -63144000000000000`,
with the exit phase active and the vault open. The older v3 keeper also resumed header submission but
was still catching up; its stale-relay gate correctly deferred folding.

## Funding and operation

Google Cloud's faucet delivered **0.05 test ETH** to the existing deployment account. Funding transaction:
`0xc179740927706105ae818bba5c8df33c55ae2994c236fb1a201c6fa67fe5e0e3`.
The seven deployment transactions consumed **13,115,533 gas**, costing **0.014274903426140085 test ETH**.
The broadcast-time estimate was 17,625,107 gas and 0.037704576138150608 test ETH at its maximum fee estimate;
the estimate is not the amount charged. Catch-up, smoke and ongoing operation are additional costs.

Measured receipts, excluding the ordinary keeper-funding transfer and later background work:

| Operation | Transactions | Gas used | Fee in test ETH |
| --- | ---: | ---: | ---: |
| Deploy the v4 stack and vault | 7 | 13,115,533 | 0.014274903426140085 |
| Bootstrap headers and fold 188 heights | 10 | 18,507,808 | 0.019844140119761768 |
| Wrap/fund/approve/mint/redeem/route smoke | 7 | 573,736 | 0.000623381447834504 |

Gas fees exclude the 0.003 test ETH wrapped during smoke and the 0.04 transfer that funded the keeper;
those are asset movements, not execution fees. Bootstrap costs include initial storage and do not establish
steady-state gas per height or an economically sufficient operating reserve.

A separate encrypted keeper account, `0x2302992F8ef33a3561bf26E19994Cf12E76F53E4`, received **0.04 test ETH**:
`0x4a3b3e98d5ff4779161b715d588e88b7f963d4af2935b49e99da5edddb92c4cd`.
Its keystore and password remain local; credential files are ignored by Git and mode 0600. No private key was
passed through command arguments. The old Sepolia keeper was stopped before deployment to reserve the
deployer's nonce; the new keeper uses its own account and nonce.

Once the old comparison keeper resumed, its remaining catch-up required more test fuel. A **0.006 test ETH**
transfer from the v4 worker back to the old worker was confirmed in
`0xc6d0858d46e0856a4e7679a12f1c3e29b482976f6e9694600a970d32124447a0`.
The v4 keeper was briefly held for this transfer, its pending nonce checked, and then resumed. This reallocates
existing test funds; it is not another faucet grant. The operation evidence records both post-transfer balances.

PublicNode intermittently timed out on read requests. One already-successful relay receipt was recovered
before resuming; it was not resent. Runtime reads switched to `https://rpc.sepolia.ethpandaops.io` after
checking chain ID and the full deployed index runtime hash. `RPC_OVERRIDE` allows startup and smoke to use
that endpoint without rewriting historical manifests; the browser uses its existing explicit RPC preference.
Both keepers were held during smoke to avoid nonce collisions and moving reserve balances. After all seven
transactions and final assertions passed, both keepers resumed with separate accounts. The v3 indexer also
restarted with the source backoff fix and the verified runtime endpoint; its immutable deployment is unchanged.

Keeper sends now estimate with the actual sender/fees and add 25% gas headroom within the existing fixed
ceiling. The chain is checked again before signing; zero/over-ceiling estimates and a changed chain produce
no transaction. This addresses unnecessarily large maximum-fee balance reservations, not execution cost.

A remaining operational limitation is slow Foundry RPC capability probing. One read-only diagnostic through
a temporary loopback forwarder recorded two `anvil_nodeInfo` probes taking 6.5 and 18.5 seconds, while the
actual `eth_call` took 635 ms; the whole `cast call` took 27.431 seconds. This is one sample, not a latency
benchmark. The forwarder was closed afterward and is not used by either keeper. Slow polling can leave the
contract behind the indexer even while exact-height reconciliation passes; this has not been fixed here.

The v4 stack uses port **8794**, `indexer/data/sepolia-v4`, and the `wuji-sepolia-v4` process prefix. Its local
cache was seeded from 169 existing v3 rows through height 967994 after recalculating every header hash,
link, increment and cumulative integer. Startup still queries canonical hashes and six descendants. A cache
seed is not independent two-source reconstruction and does not alter any on-chain genesis or checkpoint.

The page at port 8795 remains a separate read-only local frozen-exit drill. Only port 8794 is the new live
Sepolia stack. The production release registry contains no local test-relay addresses.

## Validation

- Public smoke: wrap 0.003 test ETH, donate 0.001 WETH, mint and redeem one pair, then route fees. All seven
  receipts succeeded. Wallet WETH increased by exactly 0.001999, reserve by 0.001001, and the vault's
  collateral returned to its initial balance with zero liabilities. Total mint/redeem fees were 0.000001 WETH;
  the fee router ended empty. These reserve assertions were taken before background work resumed.
- 134 Foundry tests passed on the deployed source; original financial invariants are unchanged.
- All 118 Node tests passed, including process tests for gas headroom and rejection before signing.
- Fresh full-metadata bytecode comparison: seven runtimes, PASS.
- Separate constants, deployment bindings, anchor hash/work and MTP checks: PASS.
- The prior 22-transaction frozen-exit drill remains local evidence, not a public Bitcoin reorg exercise.
- Public MetaMask signing and independent operator acceptance remain distinct from the keystore smoke.

Do not rebroadcast the deployment helper against this release or rerun funding blindly. Inspect the manifest,
receipts and operation evidence before resuming any uncertain transaction.
