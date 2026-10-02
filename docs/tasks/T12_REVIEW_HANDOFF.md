# T12 + T11-on-ZK · independent review handoff

Prepared 2026-10-02 by the authoring session. Internal tests, invariants and the self-review findings below do
not replace an independent review. Review the source, not these notes; treat every claim here as something to
check.

## 1. What to review

| object | identifier |
|---|---|
| source | branch `t12-challenge-window`, PR [MM-sheng/wuji#1](https://github.com/MM-sheng/wuji/pull/1); pin the commit you review |
| deployed `ZkWujiIndex` (Sepolia) | `0x0350ff376F14bE43CbF62cC48E73D72dB86d1DC7`, built from `047156c` — [manifest](../../contracts/deployments/sepolia-zk-t12-v2.json) |
| deployed T11 pools on it | factory `0x26b62b96416D17BBDeA4243FC84E4B616a8A64B8` from `18418d1` — same manifest → `accounts` |
| verifier | SP1 v6.1.0 Groth16, unmodified (`contracts/src/vendor/sp1`), vkey `0x005bcc55…e2e8` |

Contracts changed after those deployments only in tests; check with
`git diff 047156c -- contracts/src/ZkWujiIndex.sol` and `git diff 18418d1 -- contracts/src`.
Runtime bytecode of each deployment was compared with a local build (immutables masked); repeat it.

Read first: [T12 design and build notes](T12_CHALLENGE_WINDOW.md), [THREAT_MODEL](../THREAT_MODEL.md)
(succinct proof verification, T11), [AUDIT_NOTES](../AUDIT_NOTES.md) WUJI-08 … WUJI-12,
[T11 · Update 2026-10-01](T11_PERPETUAL_ACCOUNTS.md).

## 2. Scope

1. **`ZkWujiIndex` state machine.** Pending queue (`foldProof`, chaining via `_stateBefore`, `MAX_PENDING`,
   `MAX_PROOF_HEADERS`), `finalize` order, `dispute` / `back` / `reject` / `refute`, bond accounting (`owed`,
   `withdraw`), the header path being closed while anything is pending, `_commitReplay`, checkpoint heights
   derived by the contract (`_checkBoundaries`) versus the guest's rule. Target: a forged journal (assume the
   verifier accepts anything) can never finalize if one honest party acts within the windows; an honest batch
   can always be backed; no path locks the queue or the bonds.
2. **`RelayerRewards.award`** and the credit order between `finalize`, `foldHeaders` and `refute`.
3. **`WujiAccounts` pricing.** Mode detection (`RELAY_TIP`), A's margin table and age rounding, B through
   `ZkWujiIndex.seenTip`, the sorted pending-epoch queue (insertion, uniqueness, gas bound), `markWithHeaders`
   and tip marking in `_process`, and that mode C behaves exactly as before.
4. **`WujiAccountsFactory`** one-pool-per-call (`create(asset, tier)`) and its size margin (24,117 bytes).
5. **Off chain:** `indexer/zk-watcher.mjs` decisions, `indexer/zk-challenge.mjs` replay (must equal the
   guest), keeper guard against extending a mismatched batch, `indexer/accounts.mjs` header marking, and
   `applyHeaders` fork choice in `indexer/bitcoin-p2p.mjs`.

## 3. Where the authors are least sure

- **Header-path bar (WUJI-12).** ≈ 7 private blocks replace an honest batch or fold via `foldHeaders`. Is
  6 confirmations acceptable for a mainnet index? What would a challenge game between branches cost?
- **Griefing economics.** A wrong dispute costs `DISPUTE_BOND` (0.05 ETH) and delays honest batches by up to
  `W + R`; backing 250 headers costs ≈ 5M gas. Is the bond right at mainnet gas prices?
- **Reject reward drain.** With no watcher for `R`, a griefer can prove an honest batch, dispute it and collect
  its bounty from the reserve, once per `W + R`.
- **Forgeries cost only gas (WUJI-09).** Prover bond deferred.
- **A's model.** Poisson at 1.25× rate plus 2 h skew, rounded up per hour; a finalized tip stamped in the
  future looks younger. Is 1e-7 the right target, and is the rate factor enough near difficulty drops?
- **B's lower bound.** Supplied headers prove at least that much work exists; can a requester gain by
  supplying a valid stale branch or by withholding the newest headers within `MAX_TIP_AGE`?
- **No reorg view on ZK pools.** `_historyConsistent` is vacuous there; pools rely on the index's confirmation
  depth alone.

## 4. Reproduce

```sh
cd contracts && forge test                     # 219 tests; ZkWujiChallenge*.t.sol, WujiAccounts.zk.t.sol
forge test --mc ZkWujiChallengeInvariantTest -vv   # 32 runs × 300 calls, accept-anything verifier
cd .. && node --test indexer/*.test.mjs scripts/*.test.mjs apps/terminal/*.test.mjs
```

Live state: the terminal's "ZK · 挑战窗口" tab, or `cast call` on the addresses above; watcher and keeper logs
are local to the project machine. To run your own watcher: [T12_WATCHER.md](T12_WATCHER.md).

## 5. Reporting

Add a note under `docs/reviews/` (one finding per section: claim, failing scenario, severity, suggested fix,
tests) and open an issue or PR comment. Findings are answered in the note and recorded in AUDIT_NOTES.
