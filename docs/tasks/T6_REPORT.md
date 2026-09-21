# T6 · Whitepaper

Branch: `codex/whitepaper`. Protocol baseline: `2e9ed05` (T5). Date: 2026-09-21.

## Delivered

- [WHITEPAPER.md](../WHITEPAPER.md) and [WHITEPAPER.pdf](../WHITEPAPER.pdf): a six-page Chinese research
  whitepaper. It covers the public index first and the paired vault as an application, followed by collateral,
  height settlement, failures, design constraints, verification, preregistration and prior work. A full English
  translation was optional in T6 and is not included in this release.
- The paper separates index, instantaneous share, expiry payoff and executable market price. It describes
  absolute-position allocation, standard-token solvency assumptions, fees and rounding; it does not promise
  independence, a profitable waiting strategy or sustainable keeper economics.
- [WHITEPAPER_FACTS.json](../WHITEPAPER_FACTS.json), produced by `scripts/whitepaper-facts.mjs`, traces numbers
  to Solidity constants, public manifests and the existing real-header fixtures. Conditional distribution
  calculations and the 300000-gas / 1-gwei budget are explicitly distinguished from observations.
- [Rendering and reproduction instructions](../tools/README.md) and the optional PDF renderer. The six-page
  PDF embeds its CJK font and identifies its Markdown source hash in the footer. No production dependency was added.
- README links to both reading formats. ARCHITECTURE's target-stack table now states its actual residual
  assumptions instead of describing immutable contracts, keepers and infrastructure as having zero trust.
  It separates current WETH/CREATE testnets from future native ETH/CREATE2/ENS goals, and explains why shared
  Bitcoin input does not make cross-chain claims interchangeable or eliminate host-chain execution risks.
  NEXT's T9 premise now distinguishes a persistent folded-hash mismatch from a stored permanent halt flag.
  These are documentation corrections, not changes to decisions, parameters or runtime behaviour.

## Arithmetic and implementation details checked

- Height 800000: raw/explorer hash order, `R=74323d1b46bfc56d162ea5725ebc666028c5ee2b0a4824e32dedff53fe3ec1fd`,
  `d=-187`, increment `-2244000000000000` wad. Under a uniform-valid-hash toy model its original byte-sum
  expectation is about 2802.883; rehashing is not an anti-withholding proof.
- Under independent uniform bytes, step variance is 174760 before scaling. S standard deviation is about
  0.50165% per height and 6.01982% per 144 heights. These describe a conditional log-index model, not measured returns.
- Both v3 manifests use genesis 967826 and interval 4320: first boundary 972145. New vaults can have a short
  first series. Delayed settlement takes the predetermined checkpoint and does not force the new current share
  back to 50/50 if later heights have already been folded.
- `values()` is exactly complementary, but actual single-sided redemption rounds each payout and charges fees.
  Arbitrary split redemptions therefore do not inherit an exact net-cash identity.
- At the stated gas scenario: 0.0432 ETH/day, 3 ETH-equivalent next-height break-even reserve and 86.4 ETH/day
  fee-base volume. Zero-revenue reserve half-life is about 48.1 days if the asset earns a bounty at every height,
  ignoring base-unit rounding. These agree with the existing keeper scenario calculator.
- Evidence inventory: original 2028 headers preserved; extended range 798336–804395 has 6060 headers and four
  difficulty adjustment points; 345 Core-derived timestamp vectors remain available.

## Validation

- `forge test --root contracts`: **112 passed**, zero failures/skips. The original financial invariant settings
  remain 64 runs × 60 depth with fail-on-revert enabled. No contract source, Solidity tests or fixtures changed.
- `node --test indexer/bitcoin.test.mjs`: **3 passed**, covering all original 2028 vectors, the known digest-order
  fixture and Core REST adapter. No existing Node test changed.
- Offline fact generation matches the committed JSON; its operating-budget values agree with
  `scripts/keeper-economics.mjs`. Repository-relative whitepaper links resolve.
- PDF: **6 pages**, embedded CJK fonts, extracted text contains every section and the exact known-block hash.
  All six pages visually inspected for clipping, missing glyphs and overlapping text. Repeated renderings with
  the same toolchain/font are byte-identical. The source hash in the footer matches the final Markdown.
- `git diff --check` passes. Only documentation and optional offline documentation tooling are changed.

No chain transactions, deployments, service restarts or fresh live two-source reconstruction were performed
for T6. Existing testnet services continue independently of this documentation task.

## Review and next work

This document is not an independent audit or a mainnet release. Independent review of the exact release,
T9's frozen single-sided exit design, a real full-series settlement, independent keeper takeover and the
disappearance drill remain outstanding. T4's live full two-source reconstruction remains incomplete after
the earlier public-API rate limits; T5's RPC snapshot agreement does not replace it.

T7 is next: first write `T7_DESIGN.md` with value-based reinvestment, NAV mathematics and a clearly labelled
real-fixture simulation. The task explicitly requires design review before building a rolling contract;
there may be no suitable rolling token. T6 does not implement or imply such a product.
