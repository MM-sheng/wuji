# T7 · Rolling application design and historical replay

Branch: `codex/rolling-design`. Protocol baseline: `5a3b745` (T6). Date: 2026-09-21.

## Delivered

- [T7_DESIGN.md](T7_DESIGN.md): self-financing cash/quantity accounting, conditional log-growth analysis,
  confirmation-time information, liquidity/counterparty requirements, failure/exit conditions and a recommendation
  to defer a rolling token. It does not change WUJI's index or pair rule. No rolling contract, new token or deployment.
- [T7_SIMULATION_PLAN.json](T7_SIMULATION_PLAN.json): fixed local analysis settings, including every sensitivity
  case and censoring rule. This uses previously public development fixtures and is explicitly **not prospective
  preregistration or an out-of-sample strategy experiment**.
- [T7_SIMULATION.json](T7_SIMULATION.json): all 36 scenarios and every settlement cash ledger, fees, quantity,
  settlement-only drawdown, zero-equity indicator and final incomplete position. The JSON records the plan hash
  and SHA-256 of raw input headers. It has no generated timestamp, so identical inputs reproduce identical output.
- `scripts/rolling-study.mjs`: offline Node built-ins only; recalculates 6060 R vectors and exact integer steps,
  then replays the explicitly hypothetical acquisition/settlement ledger. Tests are included in the existing
  `scripts/*.test.mjs` CI glob without changing the workflow or any existing tests.

## Findings

Correct value reinvestment fixes the one-for-one conversion error but **does not fix log-growth drag**. In the
specified symmetric fair model at entry price N/2, a fully invested direction has factor `2g(X)`; a zero payoff
can wipe out its capital. Where the model assigns that event positive probability, expected log growth is
negative infinity. Smaller exposure preserves idle cash per cycle but does not create a positive expected log return.

The formula is conditional on pricing and information. Settlement requires six descendants, so part of the next
series is already public at the first possible rollover. A new series reference value does not guarantee a half-par
quote. Mint is paired: imbalanced demand requires outside inventory/counterparty capital or idle cash. Current
share displays cannot supply the absent price or liquidity.

The historical fixture can support just **one** complete 4320-height period with six descendants. Its hypothetical
gross cash result is 0.679168 WETH for fully invested YANG and 1.320832 WETH for fully invested YIN, each starting
with 1 WETH. These are different portfolios under assumed half-par execution, not observed trades. The historical
start height is 798336, not the live deployment genesis. The following 1734 finalized heights are an unfinished
position, not a second realized return.

The shorter 1008/144-height cases expose 6/42 complete cycles but change the application horizon. They are stress
comparisons only. They do not create more independent samples of the deployed product, and cannot establish a
profitable strategy. The input segment contains no executable price/depth, transaction arrival or failed-trade data.
All open tails are retained with unknown liquidation NAV and unrealized P&L; no winning-only trade statistics.

## Validation

- `forge test --root contracts`: **112 passed**, no failures or skips. Original financial invariants and their
  64-run / 60-depth / fail-on-revert settings remain unchanged.
- `node --test indexer/*.test.mjs scripts/*.test.mjs apps/terminal/*.test.mjs`: **84 passed** (74 existing + 10 new).
  New tests cover value-based quantities at different quotes; `1.6×0.4=0.64`; absorbing zero equity; partial cash
  preservation; missing/nonpositive quotes; unaffordable execution; exact fee rounding; paired collateral accounting;
  budget limits against an independent integer inverse; incomplete observations and complete scenario reporting.
  Existing real-header tests validate PoW, links, difficulty, MTP and all committed R vectors separately.
- Full JSON regeneration is byte-identical. The design table is checked against all 36 generated cash ratios.
  Independent Python integer accounting cross-checks the complete ledger and incomplete entry for every case.
- Repository-relative documentation links and `git diff --check` pass. Protocol source, deployment manifests,
  indexer, terminal, existing fixtures and previous tests are unchanged.

No new runtime dependencies, chain transactions, credentials, service restarts or changes to fees/permissions.
T6's published whitepaper/PDF remain unchanged; its historical report still describes that release accurately.

## Decision for review

The design-stage deliverable is complete; implementation approval and independent design review remain open.
The recommendation is to defer a pooled rolling token and, only if actual demand and quotes emerge, consider
user-directed rollover with explicit minimum output, cost and in-kind/cash exits. This is an application proposal,
not a protocol entitlement or an approved contract design.

Next protocol work is T9's admin-free frozen-state exit design and its adversarial analysis. T4's full live
two-source reconstruction, T8's independent operator / disappearance drill and a real full-series settlement
remain open. This offline study supplies none of those missing operational proofs.
