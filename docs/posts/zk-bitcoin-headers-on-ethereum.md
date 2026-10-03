# Proving Bitcoin headers on Ethereum: 100 headers for 454k gas instead of 1.9M

Draft for ethresear.ch, 2026-10-01. All numbers are measured; links point into the repository.

## TL;DR

We verify Bitcoin proof-of-work on Ethereum with no owner, no multisig and no oracle. A Solidity relay checks
the header consensus rules one header at a time (≈90k gas each with its per-header storage; ≈19k when only
the batch's end state is stored). An SP1 program checks the same rules for a
whole batch, and a Groth16 proof of that batch is verified on chain by SP1's unmodified v6.1.0 verifier:

| path | gas to advance 100 real mainnet headers |
|---|---:|
| Solidity rules, per header (`foldHeaders`) | 1,928,070 |
| one Groth16 proof | 453,888 (357,037 of it the verifier) |

The proof cost does not grow with the batch. Since 2026-09-29 a keeper proves live headers from the Bitcoin
peer-to-peer network and folds them into a contract on Sepolia (first batch: 42 headers, 323,385 gas). The
Solidity path stays deployed as an escape hatch. We also describe the trust this adds and how a challenge
window can remove most of it.

## What is checked

For each header, in both implementations: `sha256d(header) ≤ target(nBits)` with compact decoding that rejects
sign bit, zero mantissa and overflow; linkage to the parent; `nBits` equal to the parent's, or to the retarget
computed from this branch's epoch start with the ×4/÷4 clamp at a 2016 boundary; timestamp strictly above the
median of the previous eleven; timestamp at most two hours past a bound the contract supplies; cumulative work
`floor(2^256 / (target+1))`. The contract advances state only for headers with six descendants inside the
same batch, carrying continuity from `tip − 6` (carrying it from the validated tip would strand the state on
any shallow reorg).

The program also computes a small derived value, an index `U = Σ (byteSum(sha256(blockhash)) − 4080)`, so the
proof's public output is the new chain state plus `U`. That is our application; the relay does not need it.

## One set of rules, three implementations

The rules live in a `no_std`-friendly Rust crate with no zkVM dependency, used by the SP1 guest and the host.
The same rules are implemented in Solidity (the escape hatch and the original relay) and JavaScript (the
indexer). Over 6,060 real mainnet headers spanning four retargets, all three produce identical state and `U`;
the guest's committed journal is byte-identical to the host's; and a Solidity test decodes a Rust-encoded
journal and reaches the same state as the header path.

## Numbers

- ≈27.5k RISC-V cycles per header, linear (a 4,320-header month ≈ 119M cycles).
- Groth16 proof of 100 headers: 217 s end to end, of which 18 s for the Groth16 step, 31 GB peak memory, on a
  14-core Apple-silicon laptop using SP1's `native-gnark` (the Docker image is amd64-only).
- Verification: 357k gas for `verifyProof`, ≈324k for a whole `foldProof` transaction on Sepolia.

## What this adds to the trust base

The Solidity path trusts only the EVM and a few hundred readable lines. The proof path also trusts SP1's
proof system and implementation, its Groth16 circuit-specific setup (phase 2 contributions by the SP1 team,
per its documentation), and the verifier contract. SP1 has published soundness advisories before (v3 in
early 2025, pre-4.0.0 in January 2025, 6.0.0–6.0.2 in April 2026); we pin versions after those fixes. Because
our contract is immutable, a future flaw in the pinned version could not be patched, only migrated away from.

## Next: a challenge window

We plan to make a proof open a pending batch that finalizes after six hours unless someone disputes it with a
bond. A dispute is settled by asking for the batch's raw headers and checking them with the Solidity rules; an
honest batch can always be backed because Bitcoin headers are public, and a forged one cannot. A forgery then
needs SP1 to be broken *and* no honest watcher for six hours. Comparing claimed work would not be enough: a
forged journal can claim any work. Design: `docs/tasks/T12_CHALLENGE_WINDOW.md`.

## How this relates to other work

Permissionless full-rule Solidity relays already exist, including one live on mainnet since September 2026;
tBTC's LightRelay runs in production with an owner. Earlier SNARK header relays were proofs of concept, and
existing SP1 use around Bitcoin proves application state rather than the header chain. Survey with sources:
`docs/RELATED_WORK.md`.

## Limitations

Testnets only, not audited. Headers only: no transaction inclusion yet. Proving needs ≈32 GB of memory. A
single maintainer operates the keepers today; anyone can run them.

## Questions for readers

1. Is there a cheaper way to settle disputes than posting the whole batch of headers, for example bisection
   over header ranges?
2. Would you rather see PLONK (no circuit-specific setup, more gas) than Groth16 here?
3. Which applications would use a public Bitcoin header relay on Ethereum if it stayed cheap and owner-less?
