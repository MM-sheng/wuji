# T10 design: ZK header relay

Status: design, 2026-09-23. Implementation follows this document; deviations are recorded here.

## Why

Per-header on-chain verification costs ≈68k gas (post-T2) to `submit` plus ≈12k to `fold`, ×144 heights/day.
On BSC that is cents; on Ethereum L1 at 1 gwei it is ≈$50/day, which the operations reserve cannot carry at
realistic early volume (whitepaper §4: ≈86 ETH/day of fee base to break even). The target stack settles on
Ethereum L1, so L1 has to become affordable without weakening any rule.

One succinct proof verifies a whole batch for a fixed ≈300k gas regardless of batch size: roughly
**$1/month instead of $1,500/month** at the same gas price.

## The decision that shapes everything: prove the index, not just the chain

The obvious design proves "these headers chain correctly" and keeps `fold` per height. That keeps the
per-height cost and only removes `submit`.

Instead the guest computes **both**: chain validity *and* the index increment
`ΔU = Σ (byteSum(sha256(sha256d(header))) − 4080)` over the batch. The proof's public output carries ΔU, so
`submit` and `fold` collapse into a single on-chain call whose cost does not grow with the batch.

This is only sound because ΔU is a pure function of the same headers the proof already validates. Nothing
about the path definition changes: the guest recomputes exactly `docs/tasks/BTC_SOURCE.md` §"Path definition".

## Public values (committed by the proof)

```
input  : prevHash, prevHeight, prevWork, prevBits, prevEpochStart, prevTimes[11] (for MTP), U_prev,
         genesisHeight, checkpointInterval, confirmations
output : newHash, newHeight, newWork, newBits, newEpochStart, newTimes[11], U_new,
         foldedHeight, U_folded, checkpoints[] = [(height, U_at_height), ...]
```

`foldedHeight = newHeight − confirmations` and `U_folded` is the accumulator at that height: the proof
demonstrates the folded range has `confirmations` descendants inside the same validated batch, which is
exactly what `WujiIndex.CONFIRMATIONS` means today.

`checkpoints` holds every series boundary `genesisHeight + k·interval − 1` crossed at or below
`foldedHeight`. With interval 4320 and batches capped at 4320 there is at most one, but the array keeps the
rule general.

## Rules the guest enforces (must equal `contracts/src/BitcoinRelay.sol`)

1. `sha256d(header) ≤ target(nBits)`; compact decoding rejects the sign bit, zero mantissa and overflow.
2. `prevHash` linkage, in raw digest order.
3. At `height % 2016 == 0`, `nBits` equals the retarget computed from this branch's epoch-start and the
   parent's timestamp with the ×4 / ÷4 clamp; otherwise it equals the parent's `nBits`.
4. Median-time-past of the previous 11 headers is strictly less than this header's timestamp (T2b).
5. Timestamp ≤ a bound the contract supplies (future-time limit, T2b) — passed as a public input so the
   contract, not the prover, decides "now".
6. Cumulative work accumulates as `floor(2^256 / (target+1))`.

Anything the guest cannot check from headers alone (block bodies, global chain visibility) stays out of
scope, exactly as today.

## Contract

`ZkBitcoinRelay` stores one state struct and one verifier address, both immutable:

```solidity
function submitProof(bytes calldata proof, bytes calldata publicValues) external;
```

- decodes `publicValues`, requires `prev*` to equal the stored state (continuity),
- requires `newWork > storedWork` (fork choice by work; a heavier branch that forks below the stored state
  is out of scope for v1 and falls to the escape hatch and T9),
- calls `ISP1Verifier.verifyProof(vkey, publicValues, proof)` with an immutable `vkey`,
- writes the new state, applies `U_folded` to the index, records `checkpoints`,
- credits the caller one bounty per newly folded height through the existing `RelayerRewards`.

**Escape hatch.** The per-header `BitcoinRelay.submit` + `WujiIndex.fold` path stays deployed and callable.
Liveness never depends on a prover existing. A differential test drives the same fixture headers through
both paths and asserts identical `S`, `lastHeight`, checkpoints and work.

## New trust, stated plainly

The zkVM's proof system and its on-chain verifier become part of the trusted base: a soundness bug there
could admit a false ΔU. Today's trusted base is only the EVM and the header rules as written in Solidity.
This is a real increase and belongs in `THREAT_MODEL.md`. Mitigations: the verifier contract is immutable
and audited by its own project; the escape hatch means a broken prover cannot stop the protocol, only a
broken *verifier* could corrupt it; and the guest is byte-for-byte differential-tested against the Solidity
implementation over real mainnet headers.

## What is proven, and what is not (2026-09-24)

Proven here, with numbers in `docs/tasks/NEXT.md`:

- the rules crate reproduces `U` over 6060 real mainnet headers, identical to Solidity and JS;
- the guest compiles to RISC-V, executes, and commits a journal **byte-identical** to the host's;
- a real proof (`compressed`) generates and verifies locally — 44.4 s for 100 headers;
- Rust's `abi_encode` and Solidity's `abi.decode` agree on the journal, checked with real bytes;
- `ZkWujiIndex` reaches the same state through a proof journal as through raw headers.

**The Groth16 wrap, proven 2026-09-29.** A Groth16 proof of the same 100 real mainnet headers was generated
on this machine (217 s total, of which 18 s for the Groth16 step; 31 GB peak memory; SP1 6.8.0 with
`native-gnark`, circuit artifacts v6.1.0) and verified **on chain by SP1's own v6.1.0 verifier contract**
(`contracts/src/vendor/sp1`, copied unmodified). `test/ZkWujiGroth16.t.sol`:

| path | gas to advance 100 headers |
|---|---:|
| `foldHeaders` (Solidity rules, per header) | 1,928,070 |
| `foldProof` with a real Groth16 proof | 453,888 |
| of which `SP1Verifier.verifyProof` | 357,037 |

Correction 2026-10-01: this table first reported 7,956,964 for `foldHeaders`; that measurement included the
test's own byte-by-byte copy of the headers. Measured on the contract alone it is 1,928,070 (≈19k per header).

The proof path reaches the same height, hash, S and work as the header path. A tampered journal, a tampered
proof and a wrong program key are each rejected. The proof cost is flat in the batch size, so a day (144
headers) or a month (4,320) costs about the same ≈450k gas. Keeper automation (`indexer/zk-keeper.mjs`) and the public-testnet deployment followed the same day.

**First public proof, Sepolia, 2026-09-29.** `ZkWujiIndex` `0x38192BF0275DB4E1e1dD4cC3d7489C0890B49Cc9` with SP1's
v6.1.0 verifier `0x3de0B34c4516AF875b8619Ca893dF9Be44C4ca6a`, anchored at Bitcoin 969131. The keeper proved 42
live mainnet headers (969132–969173) in 264 s from the P2P source and `foldProof` advanced the index to 969167
for **323,385 gas**: tx `0x9671261fcbe53a409b2ed89577587f0bb940e0079554f8c2e9c27e5c4abc8919`.

## Build order

1. `zk/wuji-header-core` — the rules and the index accumulator as a plain `no_std`-friendly Rust crate with
   no zkVM dependency. Tested against the committed fixtures and against the JS/Solidity values.
2. SP1 guest + host wrapping that crate; measure proving time, memory and verification gas.
3. `ZkBitcoinRelay.sol` + differential tests against the existing path.
4. Keeper: prove and submit; fall back to per-header submission when proving is unavailable.

Step 1 carries the correctness risk and is worth doing first: if the Rust rules do not reproduce the exact
`U` of 2028 real headers, nothing downstream matters.

## Choice of zkVM

SP1 and RISC Zero both offer a Rust guest, a Groth16/PLONK wrapper and a Solidity verifier. The deciding
factors are sha256 precompile support (this workload is almost entirely sha256), verifier gas, and whether
a proof can be produced on a normal machine rather than a proving network. Step 2 measures both if the
first choice disappoints; the core crate in step 1 is deliberately independent of that decision.
