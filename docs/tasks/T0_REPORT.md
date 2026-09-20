# T0 — claims and terminal wording correction

Completed 2026-09-20 after the adversarial-review queue update. Parent: `0e4ebc8` on
`codex/relay-packing`. This delivery changes documentation and terminal presentation only;
contracts, tests, indexer logic, signing and the active deployment manifest are unchanged.

## Changes

- README, architecture and naming use “A market about nothing. Verifiable. Heartbeat: Bitcoin.”
  The public benchmark/random settlement positioning includes its explicit randomness assumptions.
- Index S / instantaneous settlement share / expiry payoff / executable market price are separated.
  The share is absolute-position and path-independent, not a lending-collateral price feed or an
  early single-sided redemption quote. Gross allocations are distinguished from fees/rounding.
- Cross-chain deployments are separate claims sharing an index. The interface exposes chain ID,
  collateral link, notional, series, direction and vault/token links; short symbols are not global IDs.
- Solvency is conditional on ordinary ERC-20 behaviour. Approximate UI balances no longer carry an
  unconditional “solvent” badge; arbitrary factory tokens have no equal-safety promise.
- Threat model now describes Bitcoin mode throughout: checkpoint trust, miner private cost,
  public-header-to-fold information window, missing timestamp/catch-up checks, and deep-reorg exit limitations.
  The old BSC Gap/history rules are no longer presented as Bitcoin behaviour.
- The review's `501·c_b` threshold is documented as a simplified model with hypothetical inputs,
  not a proven safe TVL cap. No contract cap or frozen-state exit is implied to exist.
- Foundations records the finite discrete distribution, raw-PoW bias derivation, preregistered benchmark
  procedure and primary-source related work. For the fixture at height 800000 (`nBits=0x17053894`),
  the uniform-valid-hash model gives raw byteSum mean ≈2802.883, not a difficulty-independent constant.
- Current testnet lifetime-point/DEAD economics are explicitly historical and superseded. T1's replacement
  remains pending; the release checklist and older active task prose now reflect the newer decisions.
- The original adversarial-review record and historical test/deployment reports are preserved as evidence.

## Terminal

Two-vault view labels percentages “Settlement share (not price)”; wallet approximations are described as
gross amounts based on that share, not market values. The index display is labeled `100e^S`. About explains
all four concepts, independent claim identities and collateral assumptions. Paper order books, fills and
leaderboards are labeled simulation; unsupported predictive/profit claims were removed from the verdict text.

The existing chart continues to plot index history, not concatenated series resets. No chart data, simulation
strategy, mint/redeem calculation, ABI or wallet transaction flow changed. Layout fixes keep the Bitcoin
status inside the chart panel, allow long tabs to scroll, and retain chart height in a narrow window.

## Verification

- Inline JavaScript parsed successfully; `git diff --check` clean.
- Browser reloaded the actual `http://localhost:8790/` page and displayed the updated wording.
- USDT and WBNB selection both displayed their correct collateral/notional/vault and settlement-share labels.
- About rendered all four concepts. At the native narrow viewport, document width equaled viewport width
  (709 px), the chart retained a positive height (about 133 px), and the long description remained readable.
- Browser error-log inspection returned no errors. No wallet mint/redeem was attempted in this wording task.
- Same-height comparison on the existing deployment: Bitcoin height 967831, contract and indexer
  `S_wad = -1056000000000000`, reconciliation `matched`. The off-chain head was later; this is a same-height
  equality check, not a claim that the relay was fully caught up.
- No diff in `contracts/` or `indexer/` against the parent. The preceding T2 validation (78 Solidity results,
  original invariants and 3 Node tests) therefore still describes the unchanged contract/indexer code.

## Remaining work

T1 operations-reserve implementation/economic model, T2b timestamp/catch-up validation and T9 frozen-state
exit are not implemented by this task. WujiVault NatSpec still has legacy terminology; its correction is
explicitly attached to the next T1 contract change to keep this task free of Solidity/metadata changes.
The full whitepaper remains T6; relevant derivations and research notes now have a corrected source to use.

The additional T2 testnet contracts were confirmed but left unused after the economic review. See
[T2 report](T2_REPORT.md) and [deployment record](../../contracts/deployments/t2-interrupted-deployment.json).
Port 8790 keeps the existing comparison deployment; no new keeper or mainnet deployment was started.
No Git remote is configured, so delivery is a local commit rather than a hosted PR. Independent review remains pending.
