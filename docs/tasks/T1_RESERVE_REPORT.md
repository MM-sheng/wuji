# T1 rework — operations reserve and one-off bounties

Branch: `codex/operations-reserve`, following the 2026-09-20 adversarial review.
Status: implementation, local validation and testnet end-to-end verification complete; independent review remains pending.
The initial source edits were included in the concurrent task-planning commit `8d792a6`; this branch completes
integration, tests, keeper operation and deployment evidence. The new Ethereum/ETH/ZK target tasks are preserved.

## Delivered behaviour

- 100% fee routing, no DEAD transfer, no perpetual points. Each selected token pays floor(reserve/10000) for
  each newly folded height. The reserve shrinks sequentially; splitting a batch gives exactly the same result.
- Only the immutable index can register the next contiguous range. The index has already checked six-deep
  canonical headers and its previous hash. No-op folds, duplicates and replaced pre-finality forks earn nothing.
- The folder selects up to eight sorted unique assets, at most 256 rewarded heights. No arbitrary token enumeration
  or token callbacks during allocation. Unselected/empty-reserve/plain-fold heights create no future entitlement.
- Claimable amounts are fixed at completion. New fees, later donations and delayed claims cannot increase old
  entitlements. Anyone can fund; unsynchronized direct transfers enter the reserve only on fund/sync.
- Optional atomic submitAndFold avoids exposing two separate operations to a competing folder. The outer caller
  receives the allocation; standalone submit/fold remain available. Whole-transaction competition remains possible.
- The keeper handles reserve manifests explicitly, uses operator-configured tokens, normally submits/folds atomically,
  and collects fees/claims every 144 heights by default. Smallest-unit transfers no longer force a transaction every poll.
- The vault's financial code, original invariant file, pair rule, fees, UNIT, confirmations and series length are preserved.
  Only the vault's outdated NatSpec changed. No owner, rescue, setter or upgrade mechanism was added.

Permissionless ordinary-token funding and a nonzero reserve do not guarantee profitability. In particular a bare
fold can advance the index without taking a bounty, and a standalone relayer can lose the folding reward to another
account. Less than 10000 base units pays zero. A depleted pool needs new fees/donations, not old-work claims.

## Validation

- 92 Solidity tests across 9 suites passed, 0 failures/skips. Original financial invariants kept byte-for-byte,
  64 runs × 60 calls, fail_on_revert=true; new reserve invariant also completed 3840 calls without reverts.
- Reserve invariant checks funding = unused reserve + fixed unpaid allocations + paid claims for two tokens and
  three workers, with a per-height reference ledger. Unit/fuzz tests cover splitting, rounding, new funding vs old
  work, token-selection limits, duplicate ranges, delayed/repeated claims and permissionless donors.
- Token failures, reentry, sender surcharge, receiver transfer fee and external balance loss are tested. An abnormal
  token cannot block allocation in another token; no test claims arbitrary ERC-20s are safe.
- Integrated tests cover real headers, original JS/Solidity byte equivalence, shallow/deep forks, original submission
  attribution, atomic caller attribution and full rollback of headers/checkpoints/allocations on failure.
- T2's 2028-header differential comparison and <=70k routine-header regression assertions still pass. The frozen
  baseline's code is unchanged except its import now points to a test-only historical rewards ABI.
- All 4 Node Bitcoin fixture, adapter and HTTP persistence/reorg tests passed. Keeper/verifier syntax and startup-shell
  syntax checks passed. Source comparison confirmed unchanged financial logic after removing comments/whitespace.
- Production runtime sizes: relay 5942, index 4085, reserve 4191, router 1115, vault 9509 bytes; all below EIP-170.

## Gas and economics

Solidity 0.8.28, optimizer 200; execution measurements below exclude transaction intrinsic/calldata gas.

| Operation | Execution gas |
|---|---:|
| Relay steady 24-header batch, per header | 68068 |
| Relay new-worker 24-header batch, per header | 69918 |
| First 24-header batch at retarget, per header | 71955 |
| Fold 16 heights, one reward token, per height | 18177 |
| Fold 16 heights, two reward tokens, per height | 18342 |
| Atomic submit/fold, first single height, two tokens | 358266 |
| Atomic submit/fold, following single height, two tokens | 197062 |
| Atomic submit/fold, following 16-height batch, per height | 78572 |
| One fixed-amount claim | 82462 |

Use the single-height measurement for normal ~10-minute following; batch cost applies to catch-up and must not
be presented as every live transaction's cost. Initialization/fork rewrites and T2b additions can cost more.
The 250k/height operating-budget scenario, explicit gas-price assumptions, reserve adequacy, fee-bearing volume
and zero-revenue decay are in ARCHITECTURE §4. Reproduce with `node scripts/keeper-economics.mjs`.
No live asset-price claims or future ZK savings are included in that budget.

## Testnet delivery

Contract source: `e6ec55e65c0a693016ebbd311a5778dfae8ec1ab`, BSC testnet chain 97, genesis 967826.
All 16 deployment receipts succeeded in EVM blocks 132152565–132152566 (16007226 total transaction gas).
Deployment donated 100000 MockUSDT and 100 MockWBNB. These balances are test fixtures, not real operating capital.

| Contract | Address |
|---|---|
| BitcoinRelay | `0x9e0afab6296ef3b56d486bd46a6911a0133419de` |
| WujiIndex | `0xe2995b903c983829d609d3fd3aec4251729bf56e` |
| Operations reserve | `0x68f96648eef7133b223b785d5f619fc0dc4e5d49` |
| FeeRouter | `0xa5c0c2261f1ca176329bf215c45f423f19cc38a9` |
| VaultFactory | `0x7917f6bf6ee5fe28cab02ce149fa381a31c8d83a` |
| USDT vault | `0xb7a67397e5eb6b59a6ab7a756c08798454c84fe2` |
| WBNB vault | `0x930f298107abf321a57ae03d5011f805a4b5b53d` |

Public evidence lives in `contracts/deployments/`:

- `bsc-testnet-reserve-v2.json`: parameters, new mock assets, all deployment receipts, source commit.
- `reserve-verification.json`: local runtime bytecode comparison for eight deployed contracts plus immutable
  bindings and index parameters. This compares compiled code with immutable slots masked, then checks those bindings.
- `reserve-smoke.json`: encrypted-keystore test transactions and raw accounting snapshots for both mock assets.
- `reserve-operation.json`: public funding/bounty/claim event replay and exact-height index reconciliation.

The first attempt is retained as `reserve-interrupted-deployment.json`: a comparison keeper consumed nonce 360
before broadcast, preventing reserve creation. Some later transactions reverted; successful calls to absent code
did not establish a usable protocol. None of those addresses is active. The second attempt used exclusive signing
and the confirmed addresses above. Known active local keeper processes now cause the deployment script to stop
before reading credentials. External signers still require operational coordination; no on-chain privilege is added.

The new terminal runs at **http://localhost:8791/** using an isolated cache and the explicit reserve-v2 manifest.
The prior :8790 stack remains a historical comparison. Local comparison keepers were briefly stopped for shared
wallet signing and resumed; indexers stayed running. Browser inspection checks new USDT/WBNB addresses and the
same-height reconciliation display. No MetaMask transaction was used in this run; signing used the existing keystore.

Live-operation evidence:

- Both mocks completed approve → mint one pair → redeem one pair → route, eight successful transactions,
  796236 total transaction gas. Fees of 0.1 MockUSDT and 0.001 MockWBNB entered the reserve in full; router and
  DEAD balances were zero, both vault balances/liabilities returned to zero, and fixed entitlements did not grow.
- The keeper atomically submitted heights 967826–967846 and folded the 15 six-deep heights through 967840.
  Transaction `0xf1afc4d2ab4fba5318529b031809befb91b4aa3edb6f50f60ac97a2cf5ce06f9` used 1715524 receipt gas.
  This is an initial 21-header/15-fold catch-up batch, not normal single-height following cost.
- It received 149.895195381398488848 MockUSDT and 0.149896544436807859 MockWBNB, then claimed both.
  Claim transactions `0xc1b96b60744f8d0646483da017b27067b806ef49896d724cc5847770e33859dc` and
  `0xdc9dd5ad062af25f33687ff85da67712f1e20985e59e2fc56feafe86182a04a3` each used 47667 receipt gas.
  These receipts include transaction overhead/refunds; the controlled test measurements above use different
  initial storage states and report execution gas. All three receipts used 0.1 gwei.
- At EVM block 132154724, event replay matched both tokens' on-chain reserves, fixed allocations and worker
  balances exactly. Funding = unused reserve + unpaid allocations + paid claims; unpaid allocations were zero.
- At EVM block 132154707, cached raw headers recomputed U=1654 and S_wad=19848000000000000 through Bitcoin
  height 967840. The contract's S, lastHeight and raw lastHash matched at that exact EVM block. The terminal
  displayed zero backlog and “bit-for-bit identical” for both collateral views. This is not the independent
  two-Bitcoin-source verifier still planned in T4.

Independent review, T2b full timestamp/catch-up checks, T9 exit rules and full-period observation remain outstanding.
No mainnet deployment is part of this task.
