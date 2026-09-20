# T3 · Sepolia / WETH and cross-chain comparison

Branch: `codex/sepolia`. Deployment source: `901fa89d506c3fb4ed2f7f278e6747df4a353bef`.
Status: implemented and verified on Sepolia; seven deployment receipts, seven WETH smoke receipts,
runtime/binding checks, live keeper bounty replay and cross-chain comparison all passed. Independent review pending.

## Scope

The T2b protocol is reused byte-for-byte: `contracts/src`, `contracts/test` and `foundry.toml` are
unchanged from `e5a8976`. Genesis 967826, checkpoint 967825, UNIT 12000000000000, six descendants and
4320-height series are retained. Fee 5 bps, paired payoffs, no owner/admin/upgrade and MIT remain unchanged.

Sepolia chain 11155111 uses WETH `0xfff9976782d46cc05630d1f6ebab18b2324d6b14`, listed in
[Uniswap's deployment table](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments).
The example notional is 0.001 WETH per pair. No mock WETH is deployed. ETH is wrapped by the existing WETH
contract, outside the WUJI vault. The fresh encrypted `wuji-sepolia` account is separate from BSC keepers.
All credentials remain ignored local files, mode 600; no private key was passed in command arguments.

## Validation

- All 112 Solidity tests passed; original invariants and configuration untouched (64 runs × 60 depth,
  fail_on_revert=true). `forge build --sizes` passed; all deployed contracts remain below EIP-170.
- 28 Node tests passed: the existing Bitcoin vectors, HTTP source, keeper cases, nine comparison cases,
  five actual-terminal wallet tests, the Sepolia RPC/network integration test and four bounded-transport-retry tests. The keeper additionally
  proves that a wrong-chain RPC causes zero signed sends.
- Wallet tests exercise the actual HTML wallet implementation with an EIP-1193 test double. Rejected/reverted
  approval stops mint; a wrong network or changed account cannot advance the flow. These are not MetaMask
  extension end-to-end results.
- Simulation completed on Sepolia state with seven operations: six protocol deployments and one factory
  creation of the WETH vault. Estimated gas with margin: 16202764; estimated maximum cost at that observation:
  0.032857731167314696 test ETH (2.027909014 gwei max fee). Actual deployment used 12055556 gas and 0.012871903833540216 test ETH across seven successful receipts in block 11745368.

The PoW faucet refused the host's IP even after CAPTCHA. Google Cloud successfully supplied 0.05 Sepolia ETH:
[funding transaction](https://sepolia.etherscan.io/tx/0x3caae4d0b5b958a05aa4b5f4d42a147f120a75c6682960b1be57b4036e65043c).
Recipient `0x85967858e2464535A12031103ABA38f2795Fe8Fd`; receipt status 1, block 11745299.
Direct Foundry RPC connections stalled intermittently. Deployment used a temporary loopback HTTP forwarder
to the same public Sepolia RPC, with bounded retries; it changed no response data and held no signing key.
The recorded public RPC remains `https://ethereum-sepolia-rpc.publicnode.com`.

## Deployed contracts and WETH smoke

Public addresses and seven receipts: [sepolia-weth-v3.json](../../contracts/deployments/sepolia-weth-v3.json).
Runtime/binding evidence: [sepolia-verification.json](../../contracts/deployments/sepolia-verification.json).

| Contract | Sepolia address |
|---|---|
| BitcoinRelay | `0xdf1cf7734eda917976e88ea88899c4f3e5ad6170` |
| WujiIndex | `0x66e5d15c4c62e81084126c5429e10208b69cc65e` |
| Operations reserve | `0x1c2a6f16fa9e481c712abe6dfa22215e833b64ae` |
| FeeRouter | `0xcd1d0e1d3f46067b6185c1719a2bffeecd2ef493` |
| WujiVaultFactory | `0x089ef351bea011a73f0832455d93277363ae052d` |
| SeriesTokenDeployer | `0xdc88c7abeffd16061649d6870f7537913b0fa9b4` |
| WETH vault | `0x8783fce1d731242b8af3c42f8680b9a7b6f1bf7d` |

[sepolia-smoke.json](../../contracts/deployments/sepolia-smoke.json) records wrapping, approvals, funding,
mint, paired redemption and routing, all receipt status 1. One pair created exactly 0.001 WETH of liabilities;
redemption returned liabilities and vault collateral to zero. The two 5 bps fees totaled 0.000001 WETH.
The reserve increased by exactly 0.001001 WETH; the wallet's net WETH increase was 0.001999 WETH.
The temporary deployment forwarder was stopped; the live services use the public RPC directly.

The terminal identifies Ethereum Sepolia, WETH, its 0.001-per-pair notional and Sepolia explorer links.
Small balances use up to eight decimals (scientific notation below 1e-8); displayed amounts remain approximate.
The Bitcoin indexer now reports solvency from exact integer balances, and the network test includes a
one-wei deficit so the former floating tolerance cannot turn a deficit into an “OK” indicator.

## Comparison semantics

`node scripts/compare-chains.mjs` reads each manifest's chain ID and pins all contract calls to an EVM block.
It checks genesis, UNIT, confirmations, interval and checkpoint hash/height/work, verifies each folded lastHash
still belongs to that relay's main chain, and selects the lower lastHeight. On a faster chain it subtracts
the exact SHA256(raw header hash) increments after that height. At most 4320 heights are subtracted; larger
gaps require catch-up. Both signed integer S and Bitcoin hash must agree. Observation EVM hashes are checked
again to detect a reorg during reads. Empty deployments report WAIT; mismatches/frozen history report FAIL.

PASS means these RPC responses agree at that height. It is not a bridge, global synchronization proof or
two-independent-source verifier. Each chain/collateral/series remains a separate claim.

## Live cross-chain evidence

- Bootstrap: [sepolia-bootstrap-comparison.json](../../contracts/deployments/sepolia-bootstrap-comparison.json)
  correctly returned WAIT at height 967825 before any Sepolia fold.
- Catch-up: [sepolia-catchup-comparison.json](../../contracts/deployments/sepolia-catchup-comparison.json)
  passed at Bitcoin 967841, S_wad 18924000000000000. BSC was ten heights ahead; subtracting those
  ten raw-hash increments exactly matched the direct Sepolia state.
- Caught up: [sepolia-comparison.json](../../contracts/deployments/sepolia-comparison.json) passed at
  Bitcoin **967851**, S_wad **30312000000000000**, both direct reads. BSC observation block 132168897;
  Sepolia observation block 11745461. Both hashes were
  `0xeb2fed18316e414ffed2dfd652d4713528a4a5216d2e00000000000000000000` (internal digest order).
  The relay had reached 967857 and its advertised-tip-age gate was fresh. These are time-stamped
  observations; normal subsequent Bitcoin blocks may put one keeper briefly ahead.

[sepolia-operation.json](../../contracts/deployments/sepolia-operation.json) replayed funding and the
26-height bounty allocations against the pinned on-chain reserve/allocated/claimable balances, checked
actual successful claim receipts, and independently recomputed all 26 cached raw headers through 967851.
The first 16 heights paid the worker 1600399360369 wei of WETH; later accrued bounties stay fixed until the
next claim. The keeper's default claim interval is 144 heights, so “allocated but unclaimed” is expected.
Historical reads on the manifest RPC intermittently timed out. The successful replay used
`READ_RPC=https://ethereum-sepolia.publicnode.com`; it verified chain ID and the identical EVM observation
block hash against the manifest RPC before combining evidence. This is a second endpoint of the same
operator, not an independent provider. Read timeouts did not weaken any accounting assertion.

## Operations

The Sepolia stack uses port 8793, prefix `wuji-sepolia`, and `indexer/data/sepolia-v3`.
The cache was bootstrapped from 26 existing public raw Bitcoin headers after recomputing every hash, U and
parent link; it then follows Bitcoin itself. This is cache reuse, not independent source verification (T4).
Its keeper uses automatic Ethereum gas estimation; BSC keeps its configured legacy gas price.
Read-only RPC transport failures now retry at most three times with unchanged parameters and observation
block. JSON-RPC execution errors fail immediately; non-read methods are not automatically retried.

`scripts/sepolia-smoke.mjs` wraps 0.003 test ETH, donates 0.001 WETH to the reserve, mints/redeems one pair,
and routes both fees. It checks exact collateral deltas and returns liabilities to zero. Run before the
Sepolia keeper to avoid shared nonce use and reserve-balance changes during this isolated smoke test.

No production deployment or independent audit is claimed. T4 independent reconstruction, T9 frozen-state
single-sided exits, T8 disappearance/economic liveness tests and T10 relay cost work remain open.
