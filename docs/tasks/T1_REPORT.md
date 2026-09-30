# T1 — immutable relayer rewards and fee routing

Implementation branch: `codex/relayer-rewards`.

The fee rate and paired-vault accounting remain unchanged. New deployments use FeeRouter as treasury,
which splits ordinary ERC-20 balances 50/50 between RelayerRewards and DEAD, retaining odd-unit dust.

## Accounting choices

- Each finalized submitted header and each folded height earn one lifetime point for their respective workers.
- Header submission records attribution; credit is delayed until six-deep canonical folding. This deliberately refines immediate submit credit in NEXT.md: a transient winning fork cannot withdraw rewards before becoming an orphan.
- Rewards use per-token accumulators plus global-sequence snapshots and worker point lots. No token/user loop on credit, no retroactive share for newly credited points. Claim catch-up is bounded and repeatable.
- Integer allocation dust stays in rewards; fractional worker entitlements survive repeated claims. An odd fee unit stays in router.
- Funding belongs to points present at sync. Lifetime points have no decay: early workers share later fees. This is not a guarantee of keeper profitability.
- No admin, owner, setters, privileged recovery or project token. Deployment binds addresses using CREATE nonce prediction and asserts the results.

## Validation

Targeted tests pass: seven reward accounting tests (including fuzz), shallow/deep fork attribution,
duplicate submission, real-header reward wiring and actual vault fee routing. The full Foundry suite passed, including original vault invariants and the new
fee-conservation invariant (each 64 runs × 60 calls, zero reverts). Nine Node tests passed.
After constructor binding guards were added, the complete reward wiring tests were rerun successfully.
A forced full build includes the deployment script and all contracts are below EIP-170. Original vault invariant assertions are unchanged.

## Gas

Solidity 0.8.28, optimizer 200. Test-body gas (not receipt intrinsic gas):

| Operation | Before rewards | With rewards |
|---|---:|---:|
| Submit per header | 103034 (24-header warm batch) | 125345 (24-header batch including first retarget) |
| Fold per height | 11988 (19-height batch) | 100712 (16-height reward batch) |

These measurements have different checkpoint/batch boundaries; they show overhead, not a controlled packing benchmark.
Keeper now folds at most 16 per call under its 6M gas limit. The next task's storage optimization is not yet applied.
T2's proposed work128 + four uint32 + bool needs 257 bits before parent, so it cannot fit its stated two-slot Node
literally; derive known from a nonzero field or change the layout with explicit bounds and tests, never truncate work.

## Testnet delivery

Repository: this repository, branch `codex/relayer-rewards`.
Twelve deployment receipts succeeded on BSC testnet. Manifest: `contracts/deployments/bsc-testnet.json`.
Previous Bitcoin deployment archived in `bsc-testnet-bitcoin-v1.json`; its running terminal at 8789 is retained.
Reward-enabled terminal at http://localhost:8790/, isolated data/rewards cache and keeper process prefix.

- Rewards: `0x4f83502eda07f069316b8e8dfbb8bee7e01a6df3`
- Router: `0x29dd54d49dbced11c6e9886c51e4f9e5915612b8`
- Relay: `0xf2bb05e55cb46c293a6ac356c3bf49b46e7c4484`
- Index: `0xec4dc4a50833d35c771aff9a2dac936ddb986cd8`

Live canonical headers 967826–967833 submitted; heights 967826–967827 folded. Contract and indexer
agree at height 967827, S_wad = 5592000000000000 (S = 0.005592); the submitting/folding wallet has 4 points.
Real relay/fold transactions:
`0xec28828dfa6882542fad3234d5e21d5ca51ee5ee4c42644282ec3887be26e529`,
`0xe8e49d3b0dbbc6a91aa12f3fbe0a2e36961e29b03073721427c86bd4b8355c1e`.

A live mint of one MockUSDT pair paid 0.05 MockUSDT fee. Routing sent 0.025 to rewards and
0.025 to DEAD; the worker successfully claimed the full 0.025 reward. Assertions and receipt hashes
are recorded in `contracts/deployments/rewards-smoke.json`. No mainnet assets were used.
Bytecode and immutable address/parameter checks are recorded in `rewards-verification.json`.

## Outstanding

No Git remote is configured, so no PR can be opened yet. Independent audit and merge are pending.
T2 storage optimization, T3 cross-chain deployment and later tasks remain separate work.
This release does not meet the relay gas target or certify economically self-sustaining keepers.
