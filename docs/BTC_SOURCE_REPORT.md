# Bitcoin source migration — review handoff

Branch: `codex/bitcoin-source`, based on `70fc13b`.
Worktree: `/Users/m/Projects/wuji-bitcoin-source`.

The new contracts use Bitcoin header work and heights. A delayed relayer cannot discard increments.
The legacy BSC comparison remains at ports 8787/8788 in the original checkout. Bitcoin terminal: http://localhost:8789/.

## Validation

- Complete `forge test --root contracts --summary` passed: index 8, vault 17, factory 8, production relay fixture/reorg tests, plus invariant suite. A subsequent added shorter/heavier branch test passed; relay now has 8 tests.
- Original five invariant assertion bodies are byte-for-byte unchanged; 64 runs × 60 calls, fail_on_revert=true. Handler switched from EVM blockhash writes to 80-byte header submission into an explicitly test-only feeder. No production PoW bypass is deployed.
- 2028 real mainnet headers (798336–800363), two observed epoch transitions including 800352. Every R and aggregate S matches Node. Known height 800000 pins raw/display byte order.
- Production relay rejects bad PoW, nBits, parent linkage and malformed batches. Three-block branch switch/deep reorg are constructed with EasyRelay; the shorter-but-heavier retarget case stubs SHA256 only within that unit test while exercising production difficulty/work/branch selection. These synthetic fork tests are not real mined orphan-chain fixtures.
- Node tests cover all fixture vectors, six-confirmation publication, proof/seconds endpoints, restart persistence and halt when published history changes. Legacy gap tests also pass.
- Deployed bytecode matches local compiled artifacts after masking immutable fields; verification record includes state parameters and source comparison of relay head.

## Gas / sizes

Measured with Solidity 0.8.28, optimizer 200 runs, `BitcoinRelayTest.test_gasTableAndRealVaultSettlement`.
Body execution gas, excluding transaction intrinsic calldata gas; single header begins at a retarget boundary.

| Operation | Gas |
| --- | ---: |
| Submit one header (cold account, first transition) | 143369 |
| Submit per header in batch of 24 (warm account) | 103034 |
| Fold per height (19 heights, includes checkpoint writes) | 11988 |
| Settle and create next pair tokens | 1235851 |

**The 60000 gas/header target is not met.** Parent/work/metadata plus canonical-height storage dominate; no validation was weakened to claim it met. Lowering storage costs remains an explicit performance gap.

Runtime bytes: relay 4072; index 2756; vault 9509; factory 15282; token deployer 3515. All below EIP-170.

## Deployment

BSC testnet chain 97, genesis Bitcoin height 967826, checkpoint 967825, interval 4320, confirmations 6.

- Relay: `0xdeb96757708da1491b7e3b32f48feb9948e11f88`
- Index: `0xea6e13c6bda56dd38d442dc7a4c598977c04fa93`
- Factory: `0x5a78fd29f7aa297d2dfe967994c8783cb0aac34f`
- USDT vault: `0x890b7dAbb92c063C77b13B6bD3f0fdAD7a1B23D1`
- WBNB vault: `0x12547F3591726FAB2886E69a7Dc18B1722cDAf03`

All ten deployment transactions succeeded; hashes/gas in `contracts/deployments/bsc-testnet.json`.
First real relay submission (967826–967828): `0x8a382b06161153dcea6953073635ab04906fadb8a19901b5c2d37ce9ba88f143`.
At verification, lastHeight=967825 and S=0: **live genesis fold is pending height 967832**, not yet a nonzero live reconciliation test. Full-period live settlement is also pending (boundary 972145).
MockUSDT and MockWBNB are new deployments; earlier test balances/tokens belong to the archived legacy contracts.

## Decisions and audit focus

- Separate submit/fold; store validation fields rather than full headers; fixture range above.
- Normalize checkpoint work to that header's own work. Omitted historical work is a common additive offset for all branches, preserving comparison; do not mislabel it absolute Core chainwork.
- Omit MTP/future-time and full block-body validation as explicitly allowed by brief. This is limited SPV, not full Bitcoin consensus. See THREAT_MODEL.md.
- Audit raw SHA digest order, target sign/overflow and compact rounding, branch-local epoch time, and deep-reorg behavior before mainnet.
- A deep reorg stops new folds, but cannot undo payouts already executed. Existing finalized checkpoint claims remain in storage; no administrator recovery exists.
- Keeper must search all known headers during multi-batch fork catchup, not only current main-chain headers.

## Outstanding delivery items

- No Git remote is configured, so no PR URL can yet be created. PR body below is ready for the intended `main` repository.
- Gas target and live six-confirmation genesis fold remain pending as described above; this report does not certify a completed independent security audit.

## PR body

Replace the BSC blockhash-based path with a Bitcoin-mainnet SPV relay and six-confirmation height folding. Retargets are validated per branch, fork choice uses cumulative work, and replacing a folded height makes fold revert. Vault fees and pair accounting remain unchanged; settlement boundaries use Bitcoin heights. Preserve the old runtime as an isolated comparison mode.

Validation: full Foundry unit/fuzz/invariant suite; 2028 real headers and all Node/Solidity R vectors; bad PoW/retarget/link rejection; shallow/deep and shorter/heavier fork tests; Node publication/restart/reorg tests; runtime size checks and BSC testnet bytecode verification. See gas table and explicit unmet 60k/header target above.

Reference implementations used during review: [Bitcoin Core PoW/retarget](https://github.com/bitcoin/bitcoin/blob/master/src/pow.cpp), [compact target arithmetic](https://github.com/bitcoin/bitcoin/blob/master/src/arith_uint256.cpp), [Core REST interface](https://github.com/bitcoin/bitcoin/blob/master/doc/REST-interface.md).
