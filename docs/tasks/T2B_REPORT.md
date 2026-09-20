# T2b — Bitcoin header time validation and bounded catch-up

Branch: `codex/bitcoin-timestamps`, based on `8ca02b1` (T1 operations reserve).
Status: implementation and local validation complete; testnet deployment evidence will be recorded below.
Independent release review remains pending. No mainnet transaction is part of this task.

## Delivered behaviour

- Every accepted header has time strictly above the median of its own eleven parent-branch timestamps and
  at most host `block.timestamp + 7200`. A branch walks its own ancestry, including checkpoint bootstrap
  history, rather than sharing the canonical tip's time window. Sorting is bounded to eleven words.
- The relay constructor takes eleven chronological raw ancestors authenticated by hash linkage to the
  trusted checkpoint's committed parent. It checks that checkpoint's own MTP and future bound as well.
- Mainnet buried minimum versions are enforced as signed int32: version 2 from 227931, 3 from 363725, 4 from 388381.
- A fold with pending heights requires the relay tip's advertised timestamp inside `[host time - 10800,
  host time + 7200]`. Stale calls revert before changing S, checkpoints or bounty allocations. `fold(0)`
  also checks a nonempty backlog; an empty backlog permits bootstrap vault creation and no-op calls.
- The prior folded-hash check runs first, including empty folds. A deep reorg is still a distinct failure;
  renewed freshness cannot bypass it. Standalone `relay.submit` remains available while folding is blocked.
- Atomic submit/fold rolls back submitted headers when its resulting tip is still stale. The keeper first
  simulates as its actual worker address, falls back to standalone submission, retains progress and defers
  folding. It resumes without an administrator when the relay meets the time rule.
- V3 manifests enable this keeper mode and the terminal's on-chain time status. The indexer pins freshness,
  best height and header timestamp to the same EVM observation block used for its contract snapshot.
- Vault financial code, original financial invariant file, fees, pair rule, UNIT, six descendants and 4320-height
  series remain unchanged. No owner, pause, parameter setter, rescue mechanism or production dependency was added.

## Core comparison and remaining limits

Primary reference is Bitcoin Core v30.0 commit `d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3`:
[chain.h](https://github.com/bitcoin/bitcoin/blob/d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3/src/chain.h),
[validation.cpp](https://github.com/bitcoin/bitcoin/blob/d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3/src/validation.cpp),
[mainnet activation parameters](https://github.com/bitcoin/bitcoin/blob/d0f6d9953a15d7c7111d46dcb76ab2bb18e5dee3/src/kernel/chainparams.cpp).
The vector generator compiles Core's verbatim MTP method with a small harness translating its two timestamp
inequalities. It records source SHA256s and produces 345 cases. This is Core-derived differential testing,
not a full Core-node test. Thresholds match, but the future bound uses the EVM host clock instead of Core NodeClock.

The age gate is not proof that the relay knows the global highest-work chain. A sufficiently recent incomplete
view can pass. A header timestamp up to two hours ahead can remain inside the three-hour age window for about
five hours after publication; different clock sources add uncertainty. A natural long Bitcoin block gap can
pause folding too. Valid new headers restore this gate without a key. Nothing here removes miner selection,
public-information delay or the unresolved one-sided exit after a deep reorg (T9).

SPV does not validate bodies, transactions, scripts, merkle/body consistency or body-dependent softfork rules.
Those omissions do not bypass the enforced PoW target or let a submitter invent chainwork without its PoW;
a header-only client can nevertheless accept a costly chain that full nodes reject for body invalidity.
Pre-checkpoint history and epoch-start parameters remain a deployment trust anchor; the eleven ancestor
headers authenticate its time window, not the full historical consensus. Future Bitcoin rule changes can
require a new immutable deployment. See [THREAT_MODEL](../THREAT_MODEL.md).

## Tests and reproducibility

- **112 Solidity tests, 10 suites, 0 failures/skips** with `forge test -vv`. Both stateful suites retained
  64 runs × 60 calls, `fail_on_revert=true`, 3840 calls each and no reverts. The original vault invariant file
  and financial contract are byte-identical to the parent release.
- The original 2028 mainnet headers remain unchanged. Extended fixtures cover **6060 headers** from 798336
  through 804395, with retargets at 798336, 800352, 802368 and 804384. Every production hash, work and MTP is
  compared with a frozen pre-T2b packed reference and the JS R vectors.
- Solidity divides this into three overlapping 2028-header windows (offsets 0, 2016, 4032), each with its proper
  checkpoint, epoch time and authenticated ancestors. This avoids changing Foundry's ordinary per-test gas
  ceiling. Node also recomputes the whole 6060-header sequence: U=6888, S_wad=82656000000000000.
- All **345 Core-derived cases** are exercised through acceptance with test-only parent windows and easy PoW:
  repeated/unsorted timestamps, equal-to-median rejection, exact future boundary, uint32 extremes. Production
  PoW is exercised separately by the real fixtures. Bootstrap tampering, branch-local MTP, signed version floors,
  stale atomic rollback, all fold paths, restoration and deep-reorg precedence have direct tests.
- **8 Node tests passed**: original fixtures/byte order, Core REST adapter, HTTP persistence/reorg, extended
  timestamp fixtures and two real keeper-process tests. Keeper tests use a local HTTP source and a non-signing
  cast double to check stale multi-batch catch-up and normal atomic following with actual-caller simulation.
- Regenerate fixtures with `scripts/fetch-bitcoin-timestamps.mjs` and `scripts/generate-bitcoin-time-vectors.mjs`.
  Only optional Core-vector generation needs a C++17 compiler. Production Node/terminal stay dependency-free.
- `forge build --sizes` passed. Runtime bytes: relay 6894, index 4547, reserve 4191, router 1115, vault 9509,
  factory 15282; all below EIP-170. The build emits lint warnings; this is not a claim of a clean independent
  static audit. Time comparisons are deliberate host-clock assumptions; bootstrap `previous` is only read
  after the first iteration assigns it. Existing token-accounting/cast lint warnings remain review items.

## Gas and operating economics

Solidity 0.8.28, optimizer 200. Controlled execution gas excludes intrinsic transaction/calldata gas and is
not an arbitrary-transaction upper bound. T1 figures below are the previous report's measurements.

| Operation | T1 before time checks | T2b |
|---|---:|---:|
| Steady 24-header relay batch / header | 68068 | 86596 |
| New-worker 24-header relay batch / header | 69918 | 91634 |
| First 24-header retarget batch / header | 71955 | 89731 |
| Whole 2028-header fixture amortized / header | 68008 (frozen baseline) | 89779 |
| Fold 16 heights, one reward asset / height | 18177 | 18742 |
| Fold 16 heights, two reward assets / height | 18342 | 18907 |
| Atomic first single height, two assets | 358266 | 398056 |
| Atomic subsequent single height, two assets | 197062 | 239866 |
| Atomic 16-height batch / height, two assets | 78572 | 100372 |
| One fixed-amount claim | 82462 | 82462 |

A test-only easy-PoW branch's fourth header replacing four canonical heights costs **222877 execution gas**
in its prepared test state. This measures one shallow rewrite with ancestor reads, not arbitrary deep-fork
cost or production mining. Long rewrites can still exceed host transaction gas limits.

The original T2 <=70000 steady/new-worker and full-fixture assertions remain against the exact frozen packed
baseline (`e6ec55e`, renamed contract/comment only). **New production timestamp validation exceeds that old
budget**; its steady/new-worker/full-fixture regression threshold is 100000. This is a disclosed changed gas
acceptance target, not a weakened solvency or arithmetic assertion. Atomic operations include folding and are
measured separately. The shorter/heavier synthetic fork fixture now uses MTP-valid times while retaining its
work-based winner and removed-height assertions.

Ordinary live following is about one header per ten minutes; use the single-height measurement, not catch-up
batch amortization. The default scenario budget is now **300000 gas/height**, allowing overhead and amortized
claims/routing; initial storage, settlement, forks and exceptional paths need more. The hypothetical 1-gwei
Ethereum case becomes 0.0432 ETH/day and 86.4 ETH/day of 5-bps fee-bearing volume, with 3 ETH-equivalent reserve
needed to cover the next height. This is not a fee/price quote or assurance of profitable operation.
Run `node scripts/keeper-economics.mjs`; detailed assumptions are in ARCHITECTURE §4. T10 remains future work.

## Deployment anchor and testnet evidence

The previous checkpoint at 967825 and genesis 967826 are preserved. Its header/hash/epoch fields were already
compared with two sources in the earlier release. For this release, `extend-checkpoint-history.mjs` retrieved
eleven predecessors from mempool.space and authenticated the complete linkage to that unchanged checkpoint.
The JSON records `historySource` and `historyVerification` separately: this was not a fresh two-provider
verification of the ancestor payload. The alternative dual-source preparation was rate-limited before writing.
No genesis reset or new trusted checkpoint was silently introduced.

The new v3 manifest, runtime verification and live-operation replay will be recorded in separate
`contracts/deployments/timestamps-*` artifacts. Old stacks remain immutable comparisons. The test deployment
uses the existing encrypted keystore and donated mock collateral only; signing nonces must be coordinated
with existing local keepers. No MetaMask flow or production-collateral test is claimed.
