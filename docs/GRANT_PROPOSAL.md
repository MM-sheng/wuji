# Grant proposal: Bitcoin proof-of-work, verified on Ethereum

Draft, 2026-09-28. Fields in [brackets] are for the applicant to fill. Amounts are estimates to be replaced by
quotes before submission.

## One-paragraph summary

We are building open, owner-less infrastructure that lets Ethereum contracts know what Bitcoin has mined
without trusting anyone: a Solidity Bitcoin header relay that enforces the full consensus header rules, a
zero-knowledge light client (SP1) that proves a whole batch of headers for a fixed on-chain cost, and a
public index derived from Bitcoin block hashes that any contract can read and anyone can recompute. The
relay and index run today on two testnets, and a Groth16 proof of 100 real mainnet headers already verifies
on chain against SP1's own verifier contract for 453,888 gas, against 1,928,070 gas for the same headers
checked one by one in Solidity. The ZK path has run on Ethereum Sepolia since 2026-09-29, proving live Bitcoin
headers from the peer-to-peer network (first batch: 42 headers, 323,385 gas). A challenge window, so that a flaw in the proof system
alone cannot corrupt the index, runs there too (proofs finalize after a window unless disputed; disputes are
settled by checking raw headers on chain). We ask for funding to pay for an independent security review,
deploy the reviewed contracts, and operate the public deployment for a year.

## The problem

Ethereum applications that need Bitcoin facts (a block exists, a header has N confirmations, a value
derived from Bitcoin's proof-of-work) mostly rely on multisig bridges or oracle committees. Trust-minimized
Solidity relays exist and some run in production, but each verifies headers one by one at ≈90k gas per
header, ≈144 headers a day: thousands of dollars a month at L1 prices, paid by whichever application embeds
the relay. Proving the header chain itself in zero knowledge, so that any batch costs one fixed
verification, has so far stayed at proof-of-concept stage.

## What exists today

**Bitcoin header relay (Solidity).** Enforces proof-of-work against the target, prevHash linkage,
difficulty retargeting with the ×4 / ÷4 clamp, median-time-past, a future-time bound, and heaviest-work fork
choice from a public checkpoint. Tested against 6,060 real mainnet headers across four retargets and 345
timestamp vectors derived from Bitcoin Core. Measured cost ≈87–90k gas per header (Sepolia, 2026-09-28:
89.6k).

**Zero-knowledge light client (SP1).** The same rules as a plain Rust crate (`wuji-header-core`, no zkVM
dependency), wrapped as an SP1 guest. The Rust crate, the Solidity relay and a JavaScript implementation
produce identical results over the real-header fixtures. Measured on a laptop (14-core, 64 GB):
≈27.5k RISC-V cycles per header; a Groth16 proof of 100 real headers in 217 s (31 GB peak memory),
verified on chain by SP1's unmodified v6.1.0 verifier: **453,888 gas for the whole batch** (357,037 of it
the verifier) versus 1,928,070 gas on the per-header Solidity path (`foldHeaders`, no per-header storage), with
identical resulting state. Tampered
journals, tampered proofs and a wrong program key are rejected. The cost is flat in batch size. The
Solidity header path stays deployed as a permissionless escape hatch, so liveness never depends on a
prover.

**Public proof-of-work index.** For every Bitcoin block six confirmations deep, `R = SHA256(block hash)`
and the index moves by `byteSum(R) − 4080`. Anyone can recompute it from Bitcoin alone; the contract, an
off-chain indexer and a browser client agree to the wei. Deterministic checkpoints every 4,320 heights.

**Failure handling.** A reorg deeper than the confirmation depth is detected, observed for 144 heights, and
the index then freezes at its last consistent state instead of continuing on a disputed history. Tested
with a local transaction drill and deployed on Sepolia.

**Operations without an operator.** A peer-to-peer Bitcoin header client (no third-party API), a keeper
that relays and folds, a watchdog, and an on-chain reserve that pays per-height bounties to whoever does
the work. No owner, admin key, pause, upgrade path, governance or token anywhere.

**Deployments.** BSC testnet since September 2026 (P2P source, continuous operation); Ethereum Sepolia with the
frozen-exit rule. One application already consumes the index on testnet: owner-less perpetual accounts
priced at Bitcoin heights that were not yet mined when requested, verified end to end on chain.

**Tests.** 163 Solidity test functions including stateful invariant suites; 150 JavaScript tests; Rust
tests with journal-fixture regeneration in CI.

## How this differs from existing work

Full survey with sources: `docs/RELATED_WORK.md`. In short:

- **Permissionless full-rule Solidity relays already exist** (for example Tacit's relay on Ethereum mainnet
  since September 2026; tBTC's LightRelay in production, with an owner). Ours is comparable on that front
  and we do not claim otherwise.
- **The header chain itself proven in ZK, with the Solidity rules as escape hatch.** Existing SP1 use proves
  application state while headers still pay per-header gas; earlier SNARK header relays were proofs of
  concept. Our Rust core is differential-tested against the Solidity and JavaScript implementations.
- **No administration from deployment:** genesis is a public constructor checkpoint; no owner, authorised
  submitter list or parameter setter.
- **A defined deep-reorg answer:** observe on chain, wait 144 heights, freeze consumers at the last
  consistent state.
- **Standalone and reusable,** not embedded in one application, plus a derived public index no other
  project publishes.

## What the grant funds

| # | Deliverable | Acceptance | Estimate |
|---|---|---|---|
| 1 | Mainnet deployment of the reviewed contracts | Deployed bytecode reproduced from the audited source; addresses published | [USD 1,000–2,000] gas and verification |
| 2 | Independent security review of relay, index, ZK index, SP1 guest and the reference application | Public report; every finding fixed or answered in writing | [USD 20,000–45,000, pending quotes] |
| 3 | Twelve months of public operation | Two independent keepers, public dashboard, monthly status notes | [USD 3,000–6,000] gas and servers |
| 4 | Documentation for integrators | Guide and example contract that reads the relay and the index | [USD 2,000–4,000] |
| | **Total** | | **[USD 26,000–57,000]** |

Already done without funding, and therefore not requested: the Groth16 verifier path, the keeper proving
pipeline, the challenge window with its watcher, and the Sepolia deployments. Milestones: the review (2) first;
mainnet deployment (1) after it; operation (3) and documentation (4) throughout.

## Why it is a public good

- **Owner-less and immutable.** Nobody can change the rules, pause the contracts or withdraw funds; fees
  only pay the people who relay and fold.
- **Recomputable.** Every value can be checked against Bitcoin by anyone, with open-source tools in three
  languages that already agree.
- **Reusable.** Any Ethereum contract can read Bitcoin headers, confirmation depth or the index without
  adopting our application.
- **Cheap to keep alive once ZK lands.** A fixed ≈300k gas per batch instead of ≈90k per header turns
  thousands of dollars a month into a few dollars, so the public deployment can be kept running.

## Limitations

- **Not audited yet.** Our own reviews found and fixed defects, three of which could have frozen funds;
  that is exactly why item 3 is in this proposal.
- **The ZK path is proven locally and on a local chain, not yet on a public network.** Proving needs a
  machine with ≈32 GB of memory.
- **Header-only verification.** It proves Bitcoin headers and work, not transactions or global visibility.
- **The ZK path adds trust in SP1** and its on-chain verifier; the raw-header path remains available.
- **Single maintainer today.** Continuity rests on the design (no owner, no upgrade, anyone can run the
  keeper and watcher from the published scripts) and on recruiting a second independent operator during the
  grant.

## Applicant

Applicant and payment details are provided privately in the application form. The project is published under
a pseudonym; the application names the developer and, where required, a legal guardian as co-signer. Built
with extensive use of AI coding assistants; every component is covered by tests, and the security review in
item 3 is independent.

## Links in the repository

`contracts/src/BitcoinRelay.sol`, `contracts/src/WujiIndex.sol`, `contracts/src/ZkWujiIndex.sol`,
`zk/wuji-header-core`, `zk/program`, `docs/THREAT_MODEL.md`, `docs/tasks/T10_DESIGN.md`,
`docs/WHITEPAPER.md`.
